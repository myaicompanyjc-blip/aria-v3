/**
 * @aria/shared — Tipos compartidos del monorepo
 *
 * Importar en cualquier paquete:
 *   import type { Session, PlannerOutput, IntentType } from '@aria/shared'
 */

// ── Intent Types ──────────────────────────────────────────────────────────────

export type IntentType =
  | 'image_generate'
  | 'image_analyze'
  | 'image_edit'
  | 'doc_pdf'
  | 'doc_word'
  | 'doc_excel'
  | 'doc_query'
  | 'doc_construction'
  | 'web_search'
  | 'voice_speak'
  | 'voice_toggle'
  | 'reminder'
  | 'help'
  | 'conversation';

export type ReasoningStrategy =
  | 'direct'
  | 'chain-of-thought'
  | 'research'
  | 'rag'
  | 'multi-agent';

export type MessageType = 'text' | 'audio' | 'image' | 'document';

// ── Session ───────────────────────────────────────────────────────────────────

export interface ShortTermEntry {
  user: string;
  assistant: string;
  ts: number;
}

export interface Session {
  sessionId: string;
  userId: string;
  currentTask: string | null;
  currentIntent: IntentType | null;
  activeDocuments: string[];
  activeTools: string[];
  shortTermMemory: ShortTermEntry[];
  createdAt: string;
  updatedAt: string;
}

// ── Planner ───────────────────────────────────────────────────────────────────

export interface PlannerOutput {
  objective: string;
  intent: IntentType;
  reasoningStrategy: ReasoningStrategy;
  requiredTools: string[];
  requiredMemories: string[];
  requiredDocuments: string[];
  executionSteps: string[];
  validationRules: string[];
  estimatedComplexity: 'low' | 'medium' | 'high';
}

// ── Reasoning ─────────────────────────────────────────────────────────────────

export interface ReasoningContext {
  userMessage: string;
  enrichedContext: string;
  memoryContext: string;
  session: Session;
}

export interface ReasoningResult {
  response: string;
  hadHallucination: boolean;
  confidence: number;
  reasoning?: string;
  critique?: string;
}

// ── Memory ────────────────────────────────────────────────────────────────────

export interface MemoryChunk {
  text: string;
  docTitle?: string;
  docId?: string;
  score?: number;
  pageNumber?: number;
}

export interface EpisodicMemory {
  id?: string;
  userMessage: string;
  assistantResponse: string;
  intent: IntentType;
  summary?: string;
  createdAt?: string;
}

export interface ContextPacket {
  ragChunks: MemoryChunk[];       // max 6
  episodicMemories: EpisodicMemory[]; // max 2
  semanticSummary: string;        // 1 summary
  workingMemory: ShortTermEntry[]; // max 8
}

// ── Agents ────────────────────────────────────────────────────────────────────

export interface AgentResult {
  type: 'document' | 'research' | 'visual' | 'voice';
  context: string;
  sources?: string[];
}

export interface OrchestrationResult {
  enrichedContext: string;
  agentsUsed: string[];
}

// ── OCR ───────────────────────────────────────────────────────────────────────

export interface OCRBlock {
  text: string;
  confidence: number;
  box?: number[][];
}

export interface OCRResult {
  text: string;
  confidence: number;
  blocks: OCRBlock[];
  engine: 'paddle' | 'tesseract' | 'none';
}

// ── API ───────────────────────────────────────────────────────────────────────

export interface ChatRequest {
  userId: string;
  message: string;
  sessionId?: string;
}

export interface ChatResponse {
  runId: string;
  userId: string;
  response: string;
  type: string;
  processingMs: number;
  rateLimitRemaining: number;
}

export interface DocumentUploadRequest {
  userId: string;
  fileName: string;
  mimeType: string;
  fileBase64: string;
  caption?: string;
}

// ── Observability ─────────────────────────────────────────────────────────────

export interface MetricsSummary {
  uptime_seconds: number;
  counters: Record<string, number>;
  histograms: Record<string, {
    count: number;
    sum: number;
    avg: number;
    min: number;
    max: number;
    p95: number;
  }>;
}

export interface LLMCallTrace {
  runId: string;
  name: string;
  inputs: Record<string, unknown>;
  outputs?: string;
  startTime: number;
  endTime: number;
  error?: Error;
}
