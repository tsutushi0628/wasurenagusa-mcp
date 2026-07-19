#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { config as dotenvConfig } from "dotenv";

import {
  memorySaveTool,
  handleMemorySave,
  memorySearchTool,
  handleMemorySearch,
  memoryGetDetailTool,
  handleMemoryGetDetail,
  memoryGetContextTool,
  handleMemoryGetContext,
  memoryDeleteTool,
  handleMemoryDelete,
  taskSubmitTool,
  handleTaskSubmit,
  taskStatusTool,
  handleTaskStatus,
  taskActionListTool,
  handleTaskActionList,
  projectInitTool,
  handleProjectInit,
  memoryUpdateIntensityTool,
  handleMemoryUpdateIntensity,
  memoryStashTool,
  handleMemoryStash,
  memoryRestoreTool,
  handleMemoryRestore,
  memoryUnarchiveTool,
  handleMemoryUnarchive,
} from "./tools/index.js";
import { findProjectRoot } from "./utils/projectRoot.js";
import { ensureOwnerProfileExists } from "./utils/owner-profile.js";
import { sanitizeErrorMessage } from "./utils/sanitize-error.js";
import { getMemoryPath } from "./config.js";
import { startZombieReaper } from "./utils/zombie-reaper.js";
import { SERVER_VERSION } from "./version.js";

dotenvConfig();

const PROJECT_ROOT = findProjectRoot();

const server = new Server(
  {
    name: "wasurenagusa-mcp",
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ツール一覧（13ツール: メモリ9 + 自律タスク3 + プロジェクト1）
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      memoryGetContextTool,
      memorySaveTool,
      memorySearchTool,
      memoryGetDetailTool,
      memoryDeleteTool,
      taskSubmitTool,
      taskStatusTool,
      taskActionListTool,
      projectInitTool,
      memoryUpdateIntensityTool,
      memoryStashTool,
      memoryRestoreTool,
      memoryUnarchiveTool,
    ],
  };
});

// ツール実行
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case "memory_get_context":
        result = await handleMemoryGetContext(args || {}, PROJECT_ROOT);
        break;
      case "memory_save":
        result = await handleMemorySave(args || {}, PROJECT_ROOT);
        break;
      case "memory_search":
        result = await handleMemorySearch(args || {}, PROJECT_ROOT);
        break;
      case "memory_get_detail":
        result = await handleMemoryGetDetail(args || {}, PROJECT_ROOT);
        break;
      case "memory_delete":
        result = await handleMemoryDelete(args || {}, PROJECT_ROOT);
        break;
      case "task_submit":
        result = await handleTaskSubmit(args || {});
        break;
      case "task_status":
        result = await handleTaskStatus(args || {});
        break;
      case "task_action_list":
        result = await handleTaskActionList(args || {});
        break;
      case "project_init":
        result = await handleProjectInit(args || {});
        break;
      case "memory_update_intensity":
        result = await handleMemoryUpdateIntensity(args || {}, PROJECT_ROOT);
        break;
      case "memory_stash":
        result = handleMemoryStash(args || {}, PROJECT_ROOT);
        break;
      case "memory_restore":
        result = handleMemoryRestore(args || {}, PROJECT_ROOT);
        break;
      case "memory_unarchive":
        result = handleMemoryUnarchive(args || {}, PROJECT_ROOT);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: result,
        },
      ],
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const errorMessage = sanitizeErrorMessage(rawMessage);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: errorMessage }),
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // owner-profile.md が未配置ならテンプレートを自動配置
  const memoryPath = getMemoryPath(PROJECT_ROOT);
  await ensureOwnerProfileExists(memoryPath);

  // ゾンビプロセスの自動掃除を開始
  startZombieReaper();

  console.error(`wasurenagusa-mcp server started (v${SERVER_VERSION})`);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
