import { describe, expect } from "bun:test"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  Model,
  InvalidRequestReason,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  type LLMClientShape,
  type LLMRequest,
} from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Database } from "@opencode-ai/core/database/database"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SessionTitle } from "@opencode-ai/core/session/title"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionContextEntry } from "@opencode-ai/core/session/context-entry"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextBuiltIns } from "@opencode-ai/core/system-context/builtins"
import { InstructionContext } from "@opencode-ai/core/instruction-context"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { McpGuidance } from "@opencode-ai/core/mcp/guidance"
import { ModelV2 } from "@opencode-ai/core/model"
import { Location } from "@opencode-ai/core/location"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Cause, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

// --- Fixtures ---

const primaryModel = Model.make({ id: "gpt-5", provider: "openai", route: OpenAIChat.route })
const primaryRef = ModelV2.Ref.make({
  id: ModelV2.ID.make("gpt-5"),
  providerID: ProviderV2.ID.make("openai"),
})

const fallbackModel = Model.make({ id: "gpt-4o", provider: "openai", route: OpenAIChat.route })
const fallbackRef = ModelV2.Ref.make({
  id: ModelV2.ID.make("gpt-4o"),
  providerID: ProviderV2.ID.make("openai"),
})

const fallback2Model = Model.make({ id: "gpt-4o-mini", provider: "openai", route: OpenAIChat.route })
const fallback2Ref = ModelV2.Ref.make({
  id: ModelV2.ID.make("gpt-4o-mini"),
  providerID: ProviderV2.ID.make("openai"),
})

const requests: LLMRequest[] = []
let response: LLMEvent[] = []
let streamFailure: LLMError | undefined

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      if (streamFailure) {
        const failure = streamFailure
        streamFailure = undefined
        return Stream.fail(failure)
      }
      return Stream.fromIterable(response)
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

// --- Mock model resolver ---
// Controls which models are "available" in the catalog.
let primaryAvailable = true
let fallbackAvailable = true
let fallback2Available = true

const models = SessionRunnerModel.layerWith((session) => {
  if (
    session.model &&
    session.model.providerID === primaryRef.providerID &&
    session.model.id === primaryRef.id
  ) {
    if (!primaryAvailable)
      return Effect.fail(
        new SessionRunnerModel.ModelUnavailableError({
          providerID: session.model.providerID,
          modelID: session.model.id,
        }),
      )
    return Effect.succeed(SessionRunnerModel.resolved(primaryModel, session.model?.variant))
  }
  if (
    session.model &&
    session.model.providerID === fallbackRef.providerID &&
    session.model.id === fallbackRef.id
  ) {
    if (!fallbackAvailable)
      return Effect.fail(
        new SessionRunnerModel.ModelUnavailableError({
          providerID: session.model.providerID,
          modelID: session.model.id,
        }),
      )
    return Effect.succeed(SessionRunnerModel.resolved(fallbackModel, session.model?.variant))
  }
  if (
    session.model &&
    session.model.providerID === fallback2Ref.providerID &&
    session.model.id === fallback2Ref.id
  ) {
    if (!fallback2Available)
      return Effect.fail(
        new SessionRunnerModel.ModelUnavailableError({
          providerID: session.model.providerID,
          modelID: session.model.id,
        }),
      )
    return Effect.succeed(SessionRunnerModel.resolved(fallback2Model, session.model?.variant))
  }
  return Effect.succeed(SessionRunnerModel.resolved(primaryModel))
})

// --- Layer setup ---

const systemContext = Layer.mock(SystemContextBuiltIns.Service, {
  load: () => Effect.succeed(SystemContext.empty),
})
const instructionContext = Layer.mock(InstructionContext.Service, { load: () => Effect.succeed(SystemContext.empty) })
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const mcpGuidance = Layer.mock(McpGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
  }),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextBuiltIns.node, systemContext],
  [InstructionContext.node, instructionContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [PermissionV2.node, permission],
  [Config.node, config],
  [McpGuidance.node, mcpGuidance],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
])

const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
      awaitIdle: coordinator.awaitIdle,
    })
  }),
).pipe(Layer.provide(runnerLayer))

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      SessionRunnerModel.node,
      SystemContextBuiltIns.node,
      InstructionContext.node,
      SessionContextEntry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [SystemContextBuiltIns.node, systemContext],
      [InstructionContext.node, instructionContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const sessionID = SessionV2.ID.make("ses_fallback_test")

const completedEvents: LLMEvent[] = [
  LLMEvent.textStart({ id: "t1" }),
  LLMEvent.textDelta({ id: "t1", text: "Hello" }),
  LLMEvent.textEnd({ id: "t1" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const setup = Effect.gen(function* () {
  primaryAvailable = true
  fallbackAvailable = true
  fallback2Available = true
  streamFailure = undefined
  response = completedEvents
  requests.length = 0

  const agent = yield* AgentV2.Service
  yield* agent.transform((editor) =>
    editor.update(AgentV2.ID.make("build"), (agent) => {
      agent.model = primaryRef
      Object.assign(agent, { fallback: [fallbackRef, fallback2Ref] })
      agent.system = "You are a test agent."
      agent.mode = "primary"
    }),
  )

  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory: "/project",
      title: "fallback test",
      model: primaryRef,
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("SessionRunner fallback", () => {
  it.effect("uses primary model when it is available", () =>
    Effect.gen(function* () {
      yield* setup
      primaryAvailable = true

      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Hello" }), resume: false })
      requests.length = 0
      yield* session.resume(sessionID)

      expect(String(requests.at(-1)?.model.id)).toBe("gpt-5")
    }),
  )

  it.effect("falls back to first fallback model when primary is unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      primaryAvailable = false

      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Test" }), resume: false })
      requests.length = 0
      yield* session.resume(sessionID)

      expect(String(requests.at(-1)?.model.id)).toBe("gpt-4o")
    }),
  )

  it.effect("publishes ModelSwitched event on fallback", () =>
    Effect.gen(function* () {
      yield* setup
      primaryAvailable = false

      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fallback test" }), resume: false })
      yield* session.resume(sessionID)

      const context = yield* session.context(sessionID)
      expect(
        context.some(
          (message) =>
            message.type === "model-switched" &&
            String(message.model.id) === "gpt-4o" &&
            String(message.model.providerID) === "openai",
        ),
      ).toBe(true)

      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(row?.model?.id).toBe("gpt-4o")
    }),
  )

  it.effect("skips fallback ref that matches current session model", () =>
    Effect.gen(function* () {
      yield* setup
      // Force session model to already be the fallback (as if previously switched)
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ model: { id: "gpt-4o", providerID: "openai" } })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)

      // Make the current session model (gpt-4o) and the primary (gpt-5) unavailable
      fallbackAvailable = false
      primaryAvailable = false

      // Make the 2nd fallback available so we can still proceed
      fallback2Available = true

      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Skip test" }), resume: false })
      requests.length = 0
      yield* session.resume(sessionID)

      // Should have skipped gpt-4o (already current) and gpt-5 (unavailable),
      // and used gpt-4o-mini instead
      expect(String(requests.at(-1)?.model.id)).toBe("gpt-4o-mini")
    }),
  )

  it.effect("falls back through multiple fallback models in order", () =>
    Effect.gen(function* () {
      yield* setup
      primaryAvailable = false
      fallbackAvailable = false
      fallback2Available = true

      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Multi fallback" }), resume: false })
      requests.length = 0
      yield* session.resume(sessionID)

      expect(String(requests.at(-1)?.model.id)).toBe("gpt-4o-mini")
    }),
  )

  it.effect("does not attempt fallback when agent has no fallback configured", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.model = primaryRef
          Object.assign(agent, { fallback: undefined })
        }),
      )
      primaryAvailable = false

      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "No fallback" }), resume: false })
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)
      // Without fallback config, the original ModelUnavailableError propagates
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("provider-failure triggers fallback when assistant has not started", () =>
    Effect.gen(function* () {
      yield* setup
      // Primary model resolves, but provider stream fails
      primaryAvailable = true
      streamFailure = new LLMError({
        module: "test",
        method: "stream",
        reason: new InvalidRequestReason({
          message: "This model is not available with your API key",
        }),
      })

      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Provider fail" }), resume: false })
      requests.length = 0
      yield* session.resume(sessionID)

      // Verify the session model was updated via ModelSwitched
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(requests.map((request) => String(request.model.id))).toEqual(["gpt-5", "gpt-4o"])
      // The fallback model should be recorded in the session
      expect(row?.model?.id).toBe("gpt-4o")
    }),
  )

  it.effect("falls back on rate limit provider failures", () =>
    Effect.gen(function* () {
      yield* setup
      primaryAvailable = true
      streamFailure = new LLMError({
        module: "test",
        method: "stream",
        reason: new RateLimitReason({
          message: "Provider request failed with HTTP 429",
        }),
      })

      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Rate limited" }), resume: false })
      requests.length = 0
      yield* session.resume(sessionID)

      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(requests.map((request) => String(request.model.id))).toEqual(["gpt-5", "gpt-4o"])
      expect(row?.model?.id).toBe("gpt-4o")
    }),
  )

  it.effect("falls back on quota exceeded provider failures", () =>
    Effect.gen(function* () {
      yield* setup
      primaryAvailable = true
      streamFailure = new LLMError({
        module: "test",
        method: "stream",
        reason: new QuotaExceededReason({
          message: "Provider quota exceeded",
        }),
      })

      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Quota exceeded" }), resume: false })
      requests.length = 0
      yield* session.resume(sessionID)

      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(requests.map((request) => String(request.model.id))).toEqual(["gpt-5", "gpt-4o"])
      expect(row?.model?.id).toBe("gpt-4o")
    }),
  )

  it.effect("falls back on provider internal failures", () =>
    Effect.gen(function* () {
      yield* setup
      primaryAvailable = true
      streamFailure = new LLMError({
        module: "test",
        method: "stream",
        reason: new ProviderInternalReason({
          message: "Provider internal error",
          status: 503,
        }),
      })

      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Provider internal" }), resume: false })
      requests.length = 0
      yield* session.resume(sessionID)

      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(requests.map((request) => String(request.model.id))).toEqual(["gpt-5", "gpt-4o"])
      expect(row?.model?.id).toBe("gpt-4o")
    }),
  )
})
