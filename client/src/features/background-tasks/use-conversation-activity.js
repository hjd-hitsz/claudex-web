import { get, rpc, set, useStoreSelector } from "../../store.js";
import { useBackgroundPoll } from "./use-background-poll.js";

export function useConversationActivity() {
  const connected = useStoreSelector((state) => state.connected);
  useBackgroundPoll(connected, 3000, async (current) => {
    try {
      const { activities } = await rpc("lan/conversations/activity");
      if (!current() || !Array.isArray(activities)) return;
      const previous = get().conversationActivity;
      if (
        activities.length !== Object.keys(previous).length ||
        activities.some((activity) => {
          const existing = previous[activity.threadId];
          return (
            !existing ||
            activity.status !== existing.status ||
            activity.turnId !== existing.turnId ||
            activity.background !== existing.background ||
            activity.generating !== existing.generating ||
            activity.activities?.join() !== existing.activities?.join()
          );
        })
      )
        set({
          conversationActivity: Object.fromEntries(
            activities.map((activity) => [activity.threadId, activity]),
          ),
        });
    } catch (error) {
      if (current() && Object.keys(get().conversationActivity).length)
        set({ conversationActivity: {} });
    }
  });
}
