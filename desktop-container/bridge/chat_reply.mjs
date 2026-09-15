// Chat turns may be synthesized as completed while the conversation is active.
// A new send is accepted only against its exact prompt and a new stable turn id.
export function selectCompletedChatReply(snapshot, { targetThreadId, requestPrompt, previousTurnIds = [] }) {
  if (!targetThreadId || snapshot?.thread?.id !== targetThreadId) throw new Error("Chat reply target thread mismatch");
  if (snapshot.thread.status?.type !== "idle") return null;
  const previous = new Set(previousTurnIds);
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
  for (const turn of turns) {
    const items = Array.isArray(turn.items) ? turn.items : [];
    if (requestPrompt !== null) {
      if (typeof requestPrompt !== "string" || !requestPrompt.trim()) throw new Error("requestPrompt must be nonempty or explicitly null for read-only mode");
      if (typeof turn.id !== "string" || !turn.id || previous.has(turn.id)) continue;
      const matches = items.some((item) => item.type === "userMessage" && Array.isArray(item.content)
        && item.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") === requestPrompt);
      if (!matches) continue;
    }
    const answer = items.filter((item) => item.type === "agentMessage" && typeof item.text === "string"
      && (item.phase === undefined || item.phase === "final_answer")).map((item) => item.text).join("\n\n");
    if (answer.trim()) return answer;
  }
  return null;
}
