const Groq = require("groq-sdk");
const mongoose = require("mongoose");
const Task = require("../models/Task");

let client;

const recentCreateRequests = new Map();
const pendingCreateRequests = new Set();

const FIXED_LOCAL_MESSAGE =
  "I can create, view, update, or delete your tasks.";

const AI_UNAVAILABLE_MESSAGE =
  "AI Assistant is temporarily unavailable. Please try again later.";

const AI_RATE_LIMITED_MESSAGE =
  "AI Assistant is temporarily busy. Please try again later.";

const AI_INVALID_MESSAGE =
  "I couldn't understand that task. Please try again with a clear title.";

const TASK_ERROR_MESSAGE =
  "The task operation could not be completed. Please try again.";

const DEFAULT_MODEL = "qwen/qwen3.8-27b";

const MAX_MESSAGE_LENGTH = 200;

const AI_MAX_OUTPUT_TOKENS = 150;

/* -------------------------------------------------------
   SYSTEM PROMPT
------------------------------------------------------- */

const today = () => {
  return new Date().toISOString().slice(0, 10);
};

const systemPrompt = () => {
  return `
You are Taskflow's task assistant.

Your job is to help the authenticated user manage tasks.

AVAILABLE TOOLS:

1. create_task
Use this ONLY when the user clearly asks to:
- create a task
- add a task
- make a task
- remind them about something

2. get_my_tasks
Use this when the user asks to:
- show tasks
- list tasks
- view tasks
- what are my tasks
- show my tasks

3. update_task
Use this when the user asks to update, edit, change, mark, complete, or finish a task.
Identify the task with its ID or a title reference. Only include fields the user asks to change.

4. delete_task
Use this when the user explicitly asks to delete or remove a task.
Identify the task with its ID or a title reference.

DO NOT use tools for:
- greetings
- normal conversation
- questions about Taskflow

For create_task:
- Extract a short title.
- Extract description if provided.
- Extract priority if provided.
- Extract due date if provided.
- Never create a userId, owner, or createdBy field.
- Resolve relative dates using today's backend date: ${today()}

If the user asks for an unsupported action such as deleting,
updating, or completing a task, use the appropriate supported tool.

For update_task and delete_task, never provide or use an owner,
userId, or createdBy field. The backend supplies ownership from JWT.

Be concise and natural.
`;
};

/* -------------------------------------------------------
   GROQ CLIENT
------------------------------------------------------- */

const getGroqClient = () => {
  if (!process.env.GROQ_API_KEY) {
    return null;
  }

  if (!client) {
    client = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });
  }

  return client;
};

/* -------------------------------------------------------
   GROQ TOOLS
------------------------------------------------------- */

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "create_task",
      description:
        "Create one new task for the authenticated user when the user clearly asks to create, add, make, or be reminded about a task.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short title of the task.",
          },
          description: {
            type: "string",
            nullable: true,
            description: "Optional description of the task.",
          },
          priority: {
            type: "string",
            nullable: true,
            enum: ["low", "medium", "high"],
            description: "Task priority.",
          },
          dueDate: {
            type: "string",
            nullable: true,
            description:
              "Due date such as YYYY-MM-DD, today, tomorrow, next Monday, or empty.",
          },
        },
        required: ["title"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "get_my_tasks",
      description:
        "Return the authenticated user's tasks when the user asks to show, list, or view their tasks.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },

  {
    type: "function",
    function: {
      name: "update_task",
      description:
        "Update one task owned by the authenticated user. Use taskId when provided; otherwise use taskTitle. Include only fields explicitly requested.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "MongoDB task ID, if provided." },
          taskTitle: {
            type: "string",
            description: "Existing task title or identifying title phrase, if no ID is provided.",
          },
          title: { type: "string", description: "New task title, only when requested." },
          description: { type: "string", description: "New task description, only when requested." },
          status: { type: "string", enum: ["todo", "in-progress", "done"] },
          priority: { type: "string", enum: ["low", "medium", "high"] },
          dueDate: {
            type: "string",
            nullable: true,
            description: "New due date such as YYYY-MM-DD, today, tomorrow, or next Monday.",
          },
        },
      },
    },
  },

  {
    type: "function",
    function: {
      name: "delete_task",
      description:
        "Delete one task owned by the authenticated user. Use taskId when provided; otherwise use taskTitle. Never delete without an unambiguous task reference.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "MongoDB task ID, if provided." },
          taskTitle: {
            type: "string",
            description: "Existing task title or identifying title phrase, if no ID is provided.",
          },
        },
      },
    },
  },
];

/* -------------------------------------------------------
   ERROR HELPERS
------------------------------------------------------- */

const getProviderDetails = (error) => {
  const status =
    error?.status ||
    error?.statusCode ||
    error?.response?.status ||
    error?.error?.status;

  const code =
    error?.code ||
    error?.error?.code ||
    error?.response?.data?.error?.code ||
    "unknown";

  const message =
    error?.message ||
    error?.error?.message ||
    error?.response?.data?.error?.message ||
    "";

  return {
    status,
    code,
    text: `${code} ${message}`.toLowerCase(),
  };
};

const isQuotaError = (details) => {
  return /insufficient[_ -]?quota|quota|billing|credit|usage limit|payment/.test(
    details.text
  );
};

const getRetryDelayMs = (details) => {
  const retryAfterSeconds = details.text.match(/retry(?: in|after)\s+([\d.]+)\s*s/);
  if (retryAfterSeconds) {
    return Math.min(Math.max(Number(retryAfterSeconds[1]) * 1000, 250), 10000);
  }
  return details.status === 503 ? 750 : 250;
};

const isRetryableProviderError = (details) =>
  details.status === 503 ||
  (details.status === 429 && !isQuotaError(details));

const getToolChoice = (message) => {
  if (/\b(create|add|make|remind)\b/i.test(message)) {
    return {
      type: "function",
      function: { name: "create_task" },
    };
  }

  if (/\b(show|list|view|what are)\b.*\b(my|the)?\s*tasks?\b/i.test(message)) {
    return {
      type: "function",
      function: { name: "get_my_tasks" },
    };
  }

  if (/\b(delete|remove)\b/i.test(message)) {
    return {
      type: "function",
      function: { name: "delete_task" },
    };
  }

  if (/\b(update|edit|change|mark|complete|finish)\b/i.test(message)) {
    return {
      type: "function",
      function: { name: "update_task" },
    };
  }

  return "auto";
};

const generateGroqResponse = async (groq, rawMessage) => {
  const messages = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: rawMessage },
  ];

  const request = () =>
    groq.chat.completions.create({
      model: process.env.GROQ_MODEL || DEFAULT_MODEL,
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: getToolChoice(rawMessage),
      max_tokens: AI_MAX_OUTPUT_TOKENS,
    });

  try {
    const completion = await request();
    return { completion, messages };
  } catch (error) {
    const details = getProviderDetails(error);
    const retry = isRetryableProviderError(details);
    console.error("Groq provider failure:", {
      status: details.status || "unknown",
      code: details.code,
      message: details.text,
      type: details.status === 429 ? "rate_limit" : details.status === 503 ? "unavailable" : "other",
      retry,
    });
    if (!retry) throw error;

    const delayMs = getRetryDelayMs(details);
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    try {
      const completion = await request();
      return { completion, messages };
    } catch (retryError) {
      const retryDetails = getProviderDetails(retryError);
      console.error("Groq provider failure:", {
        status: retryDetails.status || "unknown",
        code: retryDetails.code,
        message: retryDetails.text,
        type: retryDetails.status === 429 ? "rate_limit" : retryDetails.status === 503 ? "unavailable" : "other",
        retry: false,
      });
      throw retryError;
    }
  }
};

const getFunctionCallStep = (completion) => {
  const toolCall = completion?.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function") {
    return undefined;
  }

  return {
    id: toolCall.id,
    name: toolCall.function?.name,
    arguments: toolCall.function?.arguments || "{}",
  };
};

const sendFunctionResult = (groq, context, call, result) =>
  groq.chat.completions.create({
    model: process.env.GROQ_MODEL || DEFAULT_MODEL,
    messages: [
      ...context.messages,
      context.completion.choices[0].message,
      {
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      },
    ],
    max_tokens: AI_MAX_OUTPUT_TOKENS,
  });

const safeError = (code, message, status = 503) => {
  return (res) =>
    res.status(status).json({
      success: false,
      action: null,
      code,
      message,
    });
};

/* -------------------------------------------------------
   TASK HELPERS
------------------------------------------------------- */

const publicTask = (task) => {
  const value = task.toObject ? task.toObject() : task;

  const { owner, ...safeTask } = value;

  return safeTask;
};

const normalizeText = (value) => {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
};

/* -------------------------------------------------------
   DUE DATE
------------------------------------------------------- */

const normalizeDueDate = (value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();

  const current = new Date();

  const base = new Date(
    Date.UTC(
      current.getUTCFullYear(),
      current.getUTCMonth(),
      current.getUTCDate()
    )
  );

  let date = null;

  /* YYYY-MM-DD */

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    date = new Date(`${normalized}T00:00:00.000Z`);
  }

  /* TODAY */

  else if (normalized === "today") {
    date = base;
  }

  /* TOMORROW */

  else if (normalized === "tomorrow") {
    date = new Date(base);

    date.setUTCDate(date.getUTCDate() + 1);
  }

  /* WEEKDAY */

  else {
    const weekdays = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ];

    const weekday = normalized.replace(/^next\s+/, "");

    const target = weekdays.indexOf(weekday);

    if (target !== -1) {
      const daysAhead =
        (target - base.getUTCDay() + 7) % 7;

      date = new Date(base);

      date.setUTCDate(
        date.getUTCDate() +
          (normalized.startsWith("next ") && daysAhead === 0
            ? 7
            : daysAhead)
      );
    }
  }

  if (!date || Number.isNaN(date.getTime())) {
    throw new Error("invalid due date");
  }

  if (
    /^\d{4}-\d{2}-\d{2}$/.test(normalized) &&
    date.toISOString().slice(0, 10) !== normalized
  ) {
    throw new Error("invalid due date");
  }

  return date;
};

/* -------------------------------------------------------
   VALIDATE CREATE TASK ARGUMENTS
------------------------------------------------------- */

const validateCreateArguments = (rawArgs) => {
  if (
    !rawArgs ||
    typeof rawArgs !== "object" ||
    Array.isArray(rawArgs)
  ) {
    return null;
  }

  const allowed = new Set([
    "title",
    "description",
    "priority",
    "dueDate",
  ]);

  if (
    Object.keys(rawArgs).some(
      (key) => !allowed.has(key)
    )
  ) {
    return null;
  }

  if (typeof rawArgs.title !== "string") {
    return null;
  }

  const title = rawArgs.title.trim();

  if (!title || title.length > 100) {
    return null;
  }

  let description = rawArgs.description;

  if (
    description === null ||
    description === undefined
  ) {
    description = "";
  }

  if (
    typeof description !== "string" ||
    description.length > 500
  ) {
    return null;
  }

  const priority =
    rawArgs.priority === null ||
    rawArgs.priority === undefined
      ? undefined
      : ["low", "medium", "high"].includes(
          rawArgs.priority
        )
      ? rawArgs.priority
      : undefined;

  let dueDate = null;

  try {
    dueDate = normalizeDueDate(rawArgs.dueDate);
  } catch {
    return null;
  }

  return {
    title,
    description: description.trim(),
    ...(priority ? { priority } : {}),
    dueDate,
  };
};

/* -------------------------------------------------------
   SECURITY
------------------------------------------------------- */

const stripProtectedArguments = (args) => {
  const safeArgs = {
    ...args,
  };

  delete safeArgs.userId;
  delete safeArgs.owner;
  delete safeArgs.createdBy;

  return safeArgs;
};

/* -------------------------------------------------------
   CREATE TASK
------------------------------------------------------- */

const createTaskFromArguments = async (
  args,
  ownerId
) => {
  const task = await Task.create({
    ...args,
    owner: ownerId,
  });

  return publicTask(task);
};

/* -------------------------------------------------------
   GET USER TASKS
------------------------------------------------------- */

const getUserTasks = async (ownerId) => {
  const tasks = await Task.find({
    owner: ownerId,
  })
    .select(
      "title priority status dueDate description createdAt updatedAt"
    )
    .sort({
      updatedAt: -1,
    })
    .limit(100);

  return tasks.map(publicTask);
};

/* -------------------------------------------------------
   VALIDATE LIST ARGUMENTS
------------------------------------------------------- */

const validateListArguments = (rawArgs) => {
  return (
    rawArgs &&
    typeof rawArgs === "object" &&
    !Array.isArray(rawArgs) &&
    Object.keys(rawArgs).length === 0
  );
};

const validateTaskReference = (rawArgs) => {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return null;
  }

  if (
    (typeof rawArgs.taskId !== "string" &&
      typeof rawArgs.taskTitle !== "string" &&
      typeof rawArgs.title !== "string")
  ) {
    return null;
  }

  if (rawArgs.taskId !== undefined) {
    if (!mongoose.Types.ObjectId.isValid(rawArgs.taskId)) {
      const titleReference = rawArgs.taskId.trim();
      return titleReference ? { taskTitle: titleReference } : null;
    }
    return { taskId: rawArgs.taskId };
  }

  const taskTitle = String(rawArgs.taskTitle || rawArgs.title).trim();
  return taskTitle ? { taskTitle } : null;
};

const findOwnedTask = async (reference, ownerId) => {
  if (reference.taskId) {
    return {
      task: await Task.findOne({ _id: reference.taskId, owner: ownerId }),
      ambiguous: false,
    };
  }

  const titleReference = reference.taskTitle
    .replace(/^my\s+/i, "")
    .replace(/\s+task$/i, "")
    .trim();
  const escaped = titleReference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactMatches = await Task.find({
    owner: ownerId,
    title: { $regex: `^${escaped}$`, $options: "i" },
  }).limit(2);

  if (exactMatches.length === 1) {
    return { task: exactMatches[0], ambiguous: false };
  }
  if (exactMatches.length > 1) {
    return { task: null, ambiguous: true };
  }

  const partialMatches = await Task.find({
    owner: ownerId,
    $or: [
      { title: { $regex: escaped, $options: "i" } },
    ],
  }).limit(2);

  return {
    task: partialMatches.length === 1 ? partialMatches[0] : null,
    ambiguous: partialMatches.length > 1,
  };
};

const validateUpdateArguments = (rawArgs) => {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return null;
  }

  const reference = validateTaskReference(rawArgs);
  if (!reference) return null;

  const allowedUpdates = ["title", "description", "status", "priority", "dueDate"];
  const updates = {};
  for (const key of allowedUpdates) {
    if (!Object.prototype.hasOwnProperty.call(rawArgs, key)) continue;
    if (key === "title") {
      if (!rawArgs.taskTitle && !rawArgs.taskId) continue;
      if (typeof rawArgs.title !== "string" || !rawArgs.title.trim() || rawArgs.title.trim().length > 100) return null;
      updates.title = rawArgs.title.trim();
    } else if (key === "description") {
      if (typeof rawArgs.description !== "string" || rawArgs.description.length > 500) return null;
      updates.description = rawArgs.description.trim();
    } else if (key === "status") {
      const statusAliases = {
        completed: "done",
        complete: "done",
        finished: "done",
        finish: "done",
        "in progress": "in-progress",
        pending: "todo",
      };
      const status = statusAliases[rawArgs.status] || rawArgs.status;
      if (!["todo", "in-progress", "done"].includes(status)) return null;
      updates.status = status;
    } else if (key === "priority") {
      if (!["low", "medium", "high"].includes(rawArgs.priority)) return null;
      updates.priority = rawArgs.priority;
    } else if (key === "dueDate") {
      try {
        updates.dueDate = normalizeDueDate(rawArgs.dueDate);
      } catch {
        return null;
      }
    }
  }

  return Object.keys(updates).length ? { reference, updates } : null;
};

const validateDeleteArguments = (rawArgs) => {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return null;
  const reference = validateTaskReference(rawArgs);
  if (!reference || Object.keys(rawArgs).some((key) => !["taskId", "taskTitle", "title"].includes(key))) return null;
  return reference;
};

const taskNotFoundMessage = "I couldn't find a matching task.";
const ambiguousTaskMessage = "I found multiple matching tasks. Please specify the task ID or a more specific title.";

/* -------------------------------------------------------
   AI CHAT CONTROLLER
------------------------------------------------------- */

const chatWithAI = async (req, res) => {
  const rawMessage =
    typeof req.body?.message === "string"
      ? req.body.message.trim()
      : "";

  /* Validate message */

  if (
    rawMessage.length < 3 ||
    rawMessage.length > MAX_MESSAGE_LENGTH
  ) {
    return res.status(400).json({
      success: false,
      action: null,
      code: "AI_INVALID_REQUEST",
      message: AI_INVALID_MESSAGE,
    });
  }

  const normalized = normalizeText(rawMessage);

  try {
    /* -----------------------------------------------
       AUTHENTICATED USER
    ------------------------------------------------ */

    const ownerId = req.user?._id || req.user?.id;

    if (!ownerId) {
      return res.status(401).json({
        success: false,
        action: null,
        code: "UNAUTHORIZED",
        message: "Authentication required.",
      });
    }

    /* -----------------------------------------------
       DUPLICATE CREATE PROTECTION
    ------------------------------------------------ */

    const requestKey = `${ownerId}:${normalized}`;
    const recent = recentCreateRequests.get(requestKey);
    if (recent && Date.now() - recent.timestamp < 10000) {
      return res.json(recent.response);
    }

    /* -----------------------------------------------
       GROQ CLIENT
    ------------------------------------------------ */

    const groq = getGroqClient();

    if (!groq) {
      return safeError(
        "AI_UNAVAILABLE",
        AI_UNAVAILABLE_MESSAGE
      )(res);
    }

    /* -----------------------------------------------
       GROQ REQUEST
    ------------------------------------------------ */

    try {
      if (pendingCreateRequests.has(requestKey)) {
        return safeError("AI_RATE_LIMITED", AI_RATE_LIMITED_MESSAGE, 429)(res);
      }
      pendingCreateRequests.add(requestKey);

      const context = await generateGroqResponse(groq, rawMessage);
      const response = context.completion;

      const toolCall = getFunctionCallStep(response);

      if (!toolCall) {
        const text =
          response.choices?.[0]?.message?.content ||
          FIXED_LOCAL_MESSAGE;

        return res.json({
          success: true,
          action: null,
          message: text,
        });
      }

      let parsedArguments = toolCall.arguments || {};
      if (typeof parsedArguments === "string") {
        try {
          parsedArguments = JSON.parse(parsedArguments);
        } catch {
          return safeError("AI_INVALID_REQUEST", AI_INVALID_MESSAGE, 422)(res);
        }
      }

      if (toolCall.name === "get_my_tasks") {
        if (!validateListArguments(parsedArguments)) {
          return safeError("AI_INVALID_REQUEST", AI_INVALID_MESSAGE, 422)(res);
        }

        const tasks = await getUserTasks(ownerId);
        await sendFunctionResult(groq, context, toolCall, { tasks });
        return res.json({
          success: true,
          action: "tasks_listed",
          tasks,
          message: tasks.length > 0 ? "Here are your tasks." : "You don't have any tasks yet.",
        });
      }

      if (toolCall.name === "update_task") {
        const validatedUpdate = validateUpdateArguments(parsedArguments);
        if (!validatedUpdate) {
          return safeError("AI_INVALID_REQUEST", AI_INVALID_MESSAGE, 422)(res);
        }

        const match = await findOwnedTask(validatedUpdate.reference, ownerId);
        if (match.ambiguous) {
          return res.status(409).json({
            success: false,
            action: "task_update_needs_clarification",
            code: "TASK_AMBIGUOUS",
            message: ambiguousTaskMessage,
          });
        }
        if (!match.task) {
          return res.status(404).json({
            success: false,
            action: "task_update_failed",
            code: "TASK_NOT_FOUND",
            message: taskNotFoundMessage,
          });
        }

        Object.assign(match.task, validatedUpdate.updates);
        await match.task.save();
        const result = {
          success: true,
          action: "task_updated",
          task: publicTask(match.task),
          message: "Task updated successfully.",
        };

        try {
          await sendFunctionResult(groq, context, toolCall, result);
        } catch (error) {
          const details = getProviderDetails(error);
          console.error("Groq function-result failure:", {
            status: details.status || "unknown",
            code: details.code,
            message: details.text,
          });
        }

        recentCreateRequests.set(requestKey, {
          timestamp: Date.now(),
          response: result,
        });
        return res.json(result);
      }

      if (toolCall.name === "delete_task") {
        const reference = validateDeleteArguments(parsedArguments);
        if (!reference) {
          return safeError("AI_INVALID_REQUEST", AI_INVALID_MESSAGE, 422)(res);
        }

        const match = await findOwnedTask(reference, ownerId);
        if (match.ambiguous) {
          return res.status(409).json({
            success: false,
            action: "task_delete_needs_clarification",
            code: "TASK_AMBIGUOUS",
            message: ambiguousTaskMessage,
          });
        }
        if (!match.task) {
          return res.status(404).json({
            success: false,
            action: "task_delete_failed",
            code: "TASK_NOT_FOUND",
            message: taskNotFoundMessage,
          });
        }

        await Task.deleteOne({ _id: match.task._id, owner: ownerId });
        const result = {
          success: true,
          action: "task_deleted",
          task: publicTask(match.task),
          message: "Task deleted successfully.",
        };

        try {
          await sendFunctionResult(groq, context, toolCall, result);
        } catch (error) {
          const details = getProviderDetails(error);
          console.error("Groq function-result failure:", {
            status: details.status || "unknown",
            code: details.code,
            message: details.text,
          });
        }

        recentCreateRequests.set(requestKey, {
          timestamp: Date.now(),
          response: result,
        });
        return res.json(result);
      }

      if (toolCall.name !== "create_task") {
        return safeError("AI_INVALID_REQUEST", AI_INVALID_MESSAGE, 422)(res);
      }

      const validatedArguments = validateCreateArguments(
        stripProtectedArguments(parsedArguments)
      );
      if (!validatedArguments) {
        return safeError("AI_INVALID_REQUEST", AI_INVALID_MESSAGE, 422)(res);
      }

      const task = await createTaskFromArguments(validatedArguments, ownerId);
      const result = {
        success: true,
        action: "task_created",
        task,
        message: "Task created successfully.",
      };

      try {
        await sendFunctionResult(groq, context, toolCall, {
          success: true,
          task,
        });
      } catch (error) {
        const details = getProviderDetails(error);
        console.error("Groq function-result failure:", {
          status: details.status || "unknown",
          code: details.code,
          message: details.text,
        });
      }

      recentCreateRequests.set(requestKey, {
        timestamp: Date.now(),
        response: result,
      });
      return res.json(result);
    } catch (error) {
      const details = getProviderDetails(error);
        console.error("Taskflow Groq request failure:", {
          status: details.status || "unknown",
          code: details.code,
          message: details.text,
          type: details.status === 429 ? "rate_limit" : details.status === 503 ? "unavailable" : "taskflow",
          retry: false,
        });
      if (details.status === 429) {
        return safeError("AI_RATE_LIMITED", AI_RATE_LIMITED_MESSAGE, 429)(res);
      }
      if (details.status === 503) {
        return safeError("AI_UNAVAILABLE", AI_UNAVAILABLE_MESSAGE, 503)(res);
      }
      if (error?.name === "ValidationError" || error?.name === "MongoServerError") {
        return safeError("TASK_ERROR", TASK_ERROR_MESSAGE, 500)(res);
      }
      return safeError("AI_UNAVAILABLE", AI_UNAVAILABLE_MESSAGE)(res);
    } finally {
      pendingCreateRequests.delete(requestKey);
    }
  } catch (error) {
    console.error(
      "Taskflow AI controller failure:",
      { type: "internal", status: error?.name || "unknown" }
    );

    return safeError(
      "TASK_ERROR",
      TASK_ERROR_MESSAGE,
      500
    )(res);
  }
};

/* -------------------------------------------------------
   AI STATUS
------------------------------------------------------- */

const aiStatus = (req, res) => {
  return res.json({
    configured: Boolean(
      process.env.GROQ_API_KEY
    ),

    model:
      process.env.GROQ_MODEL ||
      DEFAULT_MODEL,
  });
};

/* -------------------------------------------------------
   EXPORTS
------------------------------------------------------- */

module.exports = {
  chatWithAI,
  aiStatus,
};