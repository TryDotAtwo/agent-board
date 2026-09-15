import { isAddressedMessage, splitTelegramText, telegramRecord } from "./bridge_core.mjs";
import { TelegramDispatcher } from "./telegram_dispatcher.mjs";
import { ProgressReporter } from "./progress_reporter.mjs";
import { TelegramInputBuffer } from "./telegram_input_buffer.mjs";
import { SenderTurnScheduler } from "./sender_turn_scheduler.mjs";
import { BoardTurnTransport } from './board_turn_transport.mjs';

export async function prepareFinalDelivery({ text, turnId, outbox }) {
  const textChunks = splitTelegramText(text || "");
  if (textChunks.length <= 2) return { textChunks, artifacts: [] };
  const artifact = await outbox.createArtifact({ relativePath: "answer.md", content: text, turnId,
    caption: "Полный ответ эксперта" });
  return { textChunks: [], artifacts: [artifact] };
}

export class BridgeRuntime {
  constructor({ client, telegram, outbox, state, saveState, archiveMessage, downloadAttachments,
    readTextAttachment, boardEnabled = false,
    expectedChat, botUsername, outboxRoot = "/data/outbox", deliveryQueue, deliveryWorker,
    log = async () => {}, setTimer, clearTimer, batchDelayMs = 1500, expertId = "default" }) {
    Object.assign(this, { client, telegram, outbox, state, saveState, archiveMessage, downloadAttachments,
      expectedChat, botUsername, outboxRoot, deliveryQueue, deliveryWorker, log, boardEnabled });
    this.expertId = expertId;
    this.dispatcher = new TelegramDispatcher({ client, expertId, readTextAttachment });
    this.scheduler = new SenderTurnScheduler({ state, saveState, allowSteer: client.supportsSteer !== false,
      dispatch: async (record) => ({ result: await this.#dispatch(record), turnId: client.getActiveTurnId(expertId) }) });
    this.inputBuffer = new TelegramInputBuffer({
      deliver: (record) => this.scheduler.accept(record),
      delayMs: batchDelayMs,
      setTimer,
      clearTimer,
    });
    this.state.origins ||= {};
    this.origins = new Map(Object.entries(this.state.origins));
    if(boardEnabled)this.boardTransport=new BoardTurnTransport({state,saveState,client,expertId,
      prepareInput:record=>this.dispatcher.prepareInput(record),
      onStarted:(record,turnId)=>this.#rememberOrigin(record,turnId)});
    this.completions = Promise.resolve();
    this.reporter = new ProgressReporter({ setTimer, clearTimer, sendStatus: async (text) => {
      const origin = this.origins.get(this.client.getActiveTurnId(this.expertId));
      if (origin) await this.telegram.sendText({ chatId: origin.chatId, text,
        ...(origin.topicId ? { topicId: origin.topicId } : {}), deliveryKind: "status" });
    }});
    client.on("turnStarted", (turn) => { if (turn.expertId === this.expertId) this.reporter.turnStarted(turn.id); });
    client.on("commentary", ({ text, expertId: source }) => { if (source === this.expertId) this.reporter.observe({ type: "commentary", text }); });
    client.on("activity", ({ item, plan, expertId: source }) => {
      if (source !== this.expertId) return;
      if (plan?.length) this.reporter.observe({ type: "plan", step: plan.find((x) => x.status === "inProgress")?.step || plan[0]?.step });
      else if (item?.type !== "reasoning") this.reporter.observe({ type: "activity", tool: item?.name || item?.type });
    });
    client.on("turnCompleted", (turn) => {
      if (turn.expertId !== this.expertId) return;
      this.completions = this.completions.then(async () => {
        if(this.boardTransport)await this.boardTransport.complete(turn.id,()=>this.#complete(turn));
        else {await this.#complete(turn);await this.scheduler.complete(turn.id);}
      })
        .catch((error) => this.log(`failed to enqueue completed turn ${turn.id}: ${error.message}`));
    });
  }

  async processUpdate(update) {
    return (await this.processUpdates([update]))[0];
  }

  async processUpdates(updates) {
    const prepared = await Promise.all((updates || []).map(async (update) => {
    const nextOffset = Math.max(this.state.offset || 0, update.update_id + 1);
    const eventType = update.edited_message ? "edited_message" : "message";
    const message = update.edited_message || update.message;
    if (!message || message.chat?.id !== this.expectedChat) {
        return { nextOffset, result: "ignored" };
    }
    const record = await this.downloadAttachments(telegramRecord(message, eventType));
    const senderUsername = String(message.from?.username || "").toLowerCase();
    record.addressed = isAddressedMessage(message, this.botUsername) && senderUsername !== this.botUsername.toLowerCase();
      return { nextOffset, eventType, record };
    }));

    const results = [];
    for (const item of prepared) {
      this.state.offset = Math.max(this.state.offset || 0, item.nextOffset);
      if (!item.record) {
        await this.saveState(this.state);
        results.push(item.result);
        continue;
      }
      await this.archiveMessage(item.record);
      await this.saveState(this.state);
      if (this.boardEnabled) { results.push("archived"); continue; }
      const result = await this.inputBuffer.accept(item.record);
      results.push(item.record.addressed || item.eventType === "edited_message" ? result : "ignored");
    }
    return results;
  }

  flushInputs() { return this.inputBuffer.flushAll(); }
  restoreScheduler() { return this.boardTransport ? this.boardTransport.restore() : this.scheduler.restore(); }

  dispatchBoardRecord(record) {
    if (!this.boardEnabled) throw new Error("Telegram board is not enabled for this expert");
    return this.boardTransport.accept(record);
  }

  reconcileBoardRecord(record) {
    if(!this.boardTransport)throw new Error('Telegram board is not enabled for this expert');
    return this.boardTransport.reconcile(record);
  }

  async #rememberOrigin(record,turnId) {
    const origin={chatId:record.chat_id,replyTo:record.message_id,
      ...(record.message_thread_id?{topicId:record.message_thread_id}:{})};
    this.origins.set(turnId,origin);this.state.origins[turnId]=origin;
    await this.saveState(this.state);
  }

  async #dispatch(record) {
    const result = await this.dispatcher.dispatch(record);
    if (result === "started") {
      const turnId = this.client.getActiveTurnId(this.expertId);
      await this.#rememberOrigin(record,turnId);
    }
    return result;
  }

  async #complete(turn) {
    this.reporter.turnCompleted(turn.id);
    const origin = this.origins.get(turn.id);
    if (!origin) return;
    const artifacts = await this.outbox.listTurnArtifacts(turn.id);
    const prepared = await prepareFinalDelivery({ text: turn.finalAnswer || "", turnId: turn.id, outbox: this.outbox });
    const textChunks = prepared.textChunks;
    artifacts.push(...prepared.artifacts);
    if (textChunks.length || artifacts.length) {
      await this.deliveryQueue.enqueue({ turnId: turn.id, chatId: origin.chatId, replyTo: origin.replyTo,
        ...(origin.topicId ? { topicId: origin.topicId } : {}), textChunks, artifacts });
    }
    this.origins.delete(turn.id);
    delete this.state.origins[turn.id];
    await this.saveState(this.state);
    if (textChunks.length || artifacts.length) this.deliveryWorker.wake();
  }
}
