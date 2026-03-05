import * as vscode from "vscode";
import { log, logWarn } from "../logger";

/**
 * 发送到 Cursor Composer 的参数。
 */
export interface CursorComposerSendParams {
  /** 需要发送的文本内容。 */
  prompt: string;
  /** 是否先打开 Agent/Chat 面板。 */
  openPanel?: boolean;
  /** 是否先创建一个新的 Composer 会话。 */
  createNew?: boolean;
  /** 是否在注入后立即发送。 */
  submit?: boolean;
  /** 手动指定“发送命令”的 command id。 */
  sendCommandId?: string;
  /** 手动指定“设置输入框”的 command id。 */
  setTextCommandId?: string;
}

type PromptArgHint =
  | "string"
  | "text-object"
  | "prompt-object"
  | "value-object"
  | "message-object"
  | "input-object"
  | "query-object"
  | "id+string"
  | "id+prompt-object"
  | "id+text-object"
  | "type-command";

interface InjectionResult {
  mode: "direct-send" | "set-and-submit";
  sendCommandId: string;
  setTextCommandId?: string;
  argHint: PromptArgHint;
}

interface CommandAttempt {
  argHint: PromptArgHint;
  argsBuilder: (prompt: string, activeComposerId: string | null) => readonly unknown[];
}

const PANEL_COMMAND_CANDIDATES: readonly string[] = [
  "workbench.panel.aichat.focus",
  "workbench.action.chat.open",
  "workbench.panel.chat.view.copilot.focus",
];

const CREATE_NEW_COMMAND_ID = "composer.createNewComposerTab";
const ACTIVE_COMPOSER_IDS_COMMAND = "composer.getOrderedSelectedComposerIds";

const DIRECT_SEND_COMMAND_CANDIDATES: readonly string[] = [
  "composer.sendMessage",
  "composer.send",
  "composer.submitPrompt",
  "aichat.sendMessage",
];

const SET_TEXT_COMMAND_CANDIDATES: readonly string[] = [
  "composer.setInput",
  "composer.setInputText",
  "composer.updateInput",
  "aichat.setInput",
];

const SUBMIT_COMMAND_CANDIDATES: readonly string[] = [
  "composer.submit",
  "composer.sendToAgent",
  "composer.send",
  "composer.sendMessage",
  "aichat.submit",
];

const FOCUS_INPUT_COMMAND_CANDIDATES: readonly string[] = [
  "composer.focusInput",
  "aichat.focusInput",
  "workbench.action.chat.focusInput",
];

/**
 * 返回所有已注册命令，用于调试和候选过滤。
 */
async function listAllCommandIds(): Promise<Set<string>> {
  const commandIds = await vscode.commands.getCommands(true);
  return new Set<string>(commandIds);
}

/**
 * 尝试执行某个命令，如果命令不存在直接跳过。
 */
async function tryCommand(
  available: Set<string>,
  commandId: string,
  argsProvider: () => readonly unknown[]
): Promise<boolean> {
  if (!available.has(commandId)) {
    return false;
  }
  try {
    const args = argsProvider();
    await vscode.commands.executeCommand(commandId, ...args);
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`composer command failed: ${commandId} (${message})`);
    return false;
  }
}

/**
 * 生成“发送/注入”时的参数形态，适配不同内部命令签名。
 */
function buildPromptArgCandidates(): readonly CommandAttempt[] {
  return [
    { argHint: "string", argsBuilder: (prompt) => [prompt] },
    { argHint: "text-object", argsBuilder: (prompt) => [{ text: prompt }] },
    { argHint: "prompt-object", argsBuilder: (prompt) => [{ prompt }] },
    { argHint: "value-object", argsBuilder: (prompt) => [{ value: prompt }] },
    { argHint: "message-object", argsBuilder: (prompt) => [{ message: prompt }] },
    { argHint: "input-object", argsBuilder: (prompt) => [{ input: prompt }] },
    { argHint: "query-object", argsBuilder: (prompt) => [{ query: prompt }] },
    {
      argHint: "id+string",
      argsBuilder: (prompt, activeComposerId) =>
        activeComposerId ? [activeComposerId, prompt] : [],
    },
    {
      argHint: "id+prompt-object",
      argsBuilder: (prompt, activeComposerId) =>
        activeComposerId ? [{ composerId: activeComposerId, prompt }] : [],
    },
    {
      argHint: "id+text-object",
      argsBuilder: (prompt, activeComposerId) =>
        activeComposerId ? [{ composerId: activeComposerId, text: prompt }] : [],
    },
  ];
}

/**
 * 合并静态候选与运行时探测候选，并去重。
 */
function mergeCandidates(
  available: Set<string>,
  staticCandidates: readonly string[],
  dynamicPattern: RegExp,
  validator?: (commandId: string) => boolean
): string[] {
  const merged = new Set<string>(
    staticCandidates.filter((id) => {
      if (!available.has(id)) return false;
      return validator ? validator(id) : true;
    })
  );
  for (const id of available) {
    if (dynamicPattern.test(id)) {
      if (!validator || validator(id)) {
        merged.add(id);
      }
    }
  }
  return [...merged];
}

/**
 * 过滤掉明显不是“发送动作”的命令，避免误判成功。
 */
function isLikelySendCommand(commandId: string): boolean {
  const id = commandId.toLowerCase();
  const hasSendIntent = /(send|submit|ask)/.test(id);
  if (!hasSendIntent) return false;
  // 排除只读/复制/面板操作等非发送行为
  const denyTokens = [
    "copy",
    "requestid",
    "open",
    "close",
    "focus",
    "toggle",
    "status",
    "title",
    "panel",
    "view",
    "track",
    "history",
    "clear",
    "select",
    "new",
    "create",
    "toagent",
  ];
  return !denyTokens.some((token) => id.includes(token));
}

/**
 * 过滤掉明显不是“设置输入框”的命令，避免把无关命令当注入成功。
 */
function isLikelySetInputCommand(commandId: string): boolean {
  const id = commandId.toLowerCase();
  const hasInputIntent = /(set|update).*(input|prompt|text)|input|prompt/.test(id);
  if (!hasInputIntent) return false;
  const denyTokens = [
    "copy",
    "requestid",
    "open",
    "close",
    "focus",
    "toggle",
    "status",
    "title",
    "panel",
    "view",
    "history",
    "clear",
    "select",
    "new",
    "create",
  ];
  return !denyTokens.some((token) => id.includes(token));
}

/**
 * 过滤掉明显不是“提交动作”的命令。
 */
function isLikelySubmitCommand(commandId: string): boolean {
  const id = commandId.toLowerCase();
  const hasSubmitIntent = /(submit|send|run|toagent)/.test(id);
  if (!hasSubmitIntent) return false;
  const denyTokens = ["copy", "requestid", "open", "focus", "toggle", "panel", "view", "status"];
  return !denyTokens.some((token) => id.includes(token));
}

/**
 * 尝试把焦点移动到聊天输入框。
 */
async function focusComposerInput(available: Set<string>): Promise<void> {
  for (const commandId of FOCUS_INPUT_COMMAND_CANDIDATES) {
    const ok = await tryCommand(available, commandId, () => []);
    if (ok) return;
  }
}

/**
 * 兜底方案：通过 VS Code 的 type 命令直接注入文本。
 * 说明：这仍然是 API 注入，不是键盘事件回放。
 */
async function injectByTypeCommand(
  available: Set<string>,
  prompt: string
): Promise<{ ok: true; argHint: PromptArgHint } | { ok: false }> {
  await focusComposerInput(available);
  const typed = await tryCommand(available, "type", () => [{ text: prompt }]);
  if (typed) {
    return { ok: true, argHint: "type-command" };
  }
  return { ok: false };
}

/**
 * 按候选命令+候选参数依次尝试，直到成功。
 */
async function tryPromptCommands(
  available: Set<string>,
  commandIds: readonly string[],
  prompt: string,
  activeComposerId: string | null
): Promise<{ ok: true; commandId: string; argHint: PromptArgHint } | { ok: false }> {
  const argCandidates = buildPromptArgCandidates();
  for (const commandId of commandIds) {
    for (const argCandidate of argCandidates) {
      const args = argCandidate.argsBuilder(prompt, activeComposerId);
      if (args.length === 0) continue;
      const ok = await tryCommand(available, commandId, () => args);
      if (ok) {
        return { ok: true, commandId, argHint: argCandidate.argHint };
      }
    }
  }
  return { ok: false };
}

/**
 * 依次尝试“提交”命令，返回真正成功的命令 id。
 */
async function trySubmitCommands(
  available: Set<string>,
  commandIds: readonly string[]
): Promise<{ ok: true; commandId: string } | { ok: false }> {
  for (const commandId of commandIds) {
    const ok = await tryCommand(available, commandId, () => []);
    if (ok) {
      return { ok: true, commandId };
    }
  }
  return { ok: false };
}

/**
 * 读取当前选中的 composer id（如果命令可用）。
 */
async function getActiveComposerId(available: Set<string>): Promise<string | null> {
  if (!available.has(ACTIVE_COMPOSER_IDS_COMMAND)) {
    return null;
  }
  try {
    const result = await vscode.commands.executeCommand<unknown>(ACTIVE_COMPOSER_IDS_COMMAND);
    if (!Array.isArray(result) || result.length === 0) {
      return null;
    }
    const first = result[0];
    return typeof first === "string" && first.trim() ? first : null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`read composer id failed: ${message}`);
    return null;
  }
}

/**
 * 通过 Cursor 内部命令实现：打开 Agent 面板、新建会话、注入并发送消息。
 */
export async function cursorComposerSend(
  params: CursorComposerSendParams
): Promise<{
  ok: true;
  result: InjectionResult;
  discoveredCommands: string[];
}> {
  const prompt = (params.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("`prompt` is required.");
  }

  const openPanel = params.openPanel ?? true;
  const createNew = params.createNew ?? true;
  const submit = params.submit ?? true;

  const available = await listAllCommandIds();
  const discoveredCommands = [...available]
    .filter((id) => /composer|aichat|chat/i.test(id))
    .sort();

  if (openPanel) {
    for (const commandId of PANEL_COMMAND_CANDIDATES) {
      const opened = await tryCommand(available, commandId, () => []);
      if (opened) break;
    }
  }

  if (createNew) {
    await tryCommand(available, CREATE_NEW_COMMAND_ID, () => []);
  }

  const activeComposerId = await getActiveComposerId(available);

  // 方案 A：优先“注入输入框”，避免仅执行 submit 导致假成功。
  const setTextCandidates = mergeCandidates(
    available,
    params.setTextCommandId ? [params.setTextCommandId] : SET_TEXT_COMMAND_CANDIDATES,
    /(composer|aichat|chat).*(input|text|prompt|query|draft|value|message)/i,
    isLikelySetInputCommand
  );
  const injected = await tryPromptCommands(
    available,
    setTextCandidates,
    prompt,
    activeComposerId
  );
  let injectedResult = injected;
  if (!injectedResult.ok) {
    const typedFallback = await injectByTypeCommand(available, prompt);
    if (typedFallback.ok) {
      // 兜底注入成功，构造统一结果格式
      injectedResult = {
        ok: true,
        commandId: "type",
        argHint: typedFallback.argHint,
      };
    }
  }
  if (!injectedResult.ok) {
    const preview = discoveredCommands.slice(0, 40).join(", ");
    throw new Error(
      "Failed to inject prompt: no compatible Cursor composer command found. " +
      `Detected ${discoveredCommands.length} related commands. Preview: [${preview}]`
    );
  }

  if (!submit) {
    const result: InjectionResult = {
      mode: "set-and-submit",
      sendCommandId: "skipped",
      setTextCommandId: injectedResult.commandId,
      argHint: injectedResult.argHint,
    };
    return { ok: true, result, discoveredCommands };
  }

  const submitCandidates = mergeCandidates(
    available,
    SUBMIT_COMMAND_CANDIDATES,
    /(composer|aichat|chat).*(submit|send|confirm|accept|run)/i,
    isLikelySubmitCommand
  );
  const submitted = await trySubmitCommands(available, submitCandidates);
  if (!submitted.ok) {
    throw new Error(
      `Prompt injected by "${injected.commandId}", but submit command was not found.`
    );
  }

  const result: InjectionResult = {
    mode: "set-and-submit",
    sendCommandId: submitted.commandId,
    setTextCommandId: injectedResult.commandId,
    argHint: injectedResult.argHint,
  };
  log(`cursor.composer.send: set=${injectedResult.commandId}, submit=${result.sendCommandId}`);
  return { ok: true, result, discoveredCommands };
}

/**
 * 输出可见的 Cursor/Composer 相关命令，便于外部调用前先探测。
 */
export async function cursorComposerCommands(): Promise<{
  commands: string[];
}> {
  const all = await vscode.commands.getCommands(true);
  const commands = all.filter((id) => /composer|aichat|chat/i.test(id)).sort();
  return { commands };
}
