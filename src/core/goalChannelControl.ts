import type { ActorIdentity } from "../types";
import type { ChatSession, SessionStore } from "./sessionStore";
import type { GoalScheduler } from "./goalScheduler";

export interface GoalChannelControlDeps {
  sessions: Pick<SessionStore, "bindGoalSource" | "pauseGoal" | "activeId" | "get"> | null;
  goals: Pick<GoalScheduler, "hold" | "publish" | "nudge">;
  stopGoalRun(sessionId: string, reason?: string): void;
}

/** One command owns a delivery hold until its actual channel acknowledgement settles. */
export function createGoalChannelControl(deps: GoalChannelControlDeps, actor: ActorIdentity, key: string) {
  let session: ChatSession | undefined;
  let release: (() => void) | undefined;
  return {
    onGoalChanged(s: ChatSession, action: string) {
      session = s;
      release ??= deps.goals.hold(s.id);
      if (!s.goal) return;
      if (["pause", "cancel", "complete"].includes(action)) deps.stopGoalRun(s.id, `goal ${action}`);
      else {
        try { deps.sessions!.bindGoalSource(s, s.goal.id, { channel: s.channel, key, actor, authorId: actor.id }); }
        catch (error) {
          if (s.goal.status === "active") deps.sessions!.pauseGoal(s, s.goal.id, {
            kind: "authorization", reason: "GOAL 原有来源与当前入口不匹配，请回到原会话确认。",
          });
          deps.goals.publish(s);
          throw error;
        }
      }
      deps.goals.publish(s);
    },
    release(delivered = true) {
      if (!delivered && session?.goal?.status === "active") {
        deps.sessions!.pauseGoal(session, session.goal.id, {
          kind: "external", reason: "GOAL 命令确认发送失败，已暂停；请查看会话后恢复。",
        });
        deps.goals.publish(session);
      }
      release?.();
      if (session) deps.goals.nudge(session.id);
    },
  };
}

/** A new authenticated owner message pauses only its own active channel session. */
export function interruptGoalForChannelMessage(deps: GoalChannelControlDeps, actor: ActorIdentity, key: string): void {
  if (actor.role !== "owner") return;
  const id = deps.sessions?.activeId(key);
  const session = id ? deps.sessions?.get(id) : undefined;
  if (!session?.goal?.autoContinue || session.goal.status !== "active" || session.goal.continuation.state !== "running") return;
  deps.sessions!.pauseGoal(session, session.goal.id, {
    kind: "user", reason: "你发来了新消息，目标已暂停；先处理新消息，之后可明确恢复目标。",
  });
  deps.stopGoalRun(session.id, "new user message");
  deps.goals.publish(session);
}
