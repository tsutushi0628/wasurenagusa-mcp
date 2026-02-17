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
} from "./tools/index.js";
import { findProjectRoot } from "./utils/projectRoot.js";
import { ensureOwnerProfileExists } from "./utils/owner-profile.js";
import { getMemoryPath } from "./config.js";

dotenvConfig();

const PROJECT_ROOT = findProjectRoot();

const server = new Server(
  {
    name: "wasurenagusa-mcp",
    version: "0.3.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ツール一覧（9ツール: 既存5 + 自律タスク4）
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
    const errorMessage = error instanceof Error ? error.message : String(error);
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

  console.error("wasurenagusa-mcp server started (v0.3.0)");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
