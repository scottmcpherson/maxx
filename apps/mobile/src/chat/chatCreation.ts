import { CHATS_PROJECT_ID, type ChatProvider } from "../types";

export type NewChatRuntime = {
  provider: ChatProvider;
  model: string;
  title: string;
  effort: string | null;
  speed: string | null;
};

export function chatCreationRequest(projectID: string, runtime: NewChatRuntime) {
  if (projectID === CHATS_PROJECT_ID) {
    return { method: "add_chat", params: runtime } as const;
  }

  return {
    method: "add_thread_with_runtime",
    params: {
      projectId: projectID,
      ...runtime,
      surface: "gui",
      worktree: false,
    },
  } as const;
}
