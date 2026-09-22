import type { RuntimeState, Telemetry } from './types.js';

const terminal = new Set<RuntimeState>(['PASSED', 'FAILED', 'CANCELLED']);

const allowed: Record<RuntimeState, readonly RuntimeState[]> = {
  CREATED: ['COMPILED', 'FAILED', 'CANCELLED'],
  COMPILED: ['INDEXED', 'FAILED', 'CANCELLED'],
  INDEXED: ['CONTEXT_GRANTED', 'FAILED', 'CANCELLED'],
  CONTEXT_GRANTED: ['WORKER_RUNNING', 'PATCH_LOWERED', 'FAILED', 'CANCELLED'],
  WORKER_RUNNING: [
    'RESPONSE_NORMALIZED',
    'PROTOCOL_REPAIR',
    'FAILED',
    'CANCELLED',
  ],
  RESPONSE_NORMALIZED: ['RESPONSE_VALIDATED', 'FAILED', 'CANCELLED'],
  RESPONSE_VALIDATED: [
    'CONTEXT_FAULT',
    'PATCH_LOWERED',
    'PATCH_REVISION',
    'FAILED',
    'CANCELLED',
  ],
  CONTEXT_FAULT: ['CONTEXT_GRANTED', 'FAILED', 'CANCELLED'],
  PATCH_LOWERED: ['TRANSACTION_RUNNING', 'FAILED', 'CANCELLED'],
  PROTOCOL_REPAIR: ['WORKER_RUNNING', 'FAILED', 'CANCELLED'],
  // A rejected patch (edit-grant lowering) or failed verification returns the
  // concrete error to the worker for a bounded number of corrected patches.
  PATCH_REVISION: ['WORKER_RUNNING', 'FAILED', 'CANCELLED'],
  TRANSACTION_RUNNING: ['VERIFYING', 'FAILED', 'CANCELLED'],
  VERIFYING: ['PASSED', 'PATCH_REVISION', 'FAILED', 'CANCELLED'],
  PASSED: [],
  FAILED: [],
  CANCELLED: [],
};

export class RuntimeStateMachine {
  state: RuntimeState = 'CREATED';

  constructor(private readonly metrics: Telemetry) {
    this.metrics.runtimeStateTransitions.push({
      from: null,
      to: 'CREATED',
      at: new Date().toISOString(),
    });
  }

  transition(to: RuntimeState, reason?: string) {
    if (!allowed[this.state].includes(to)) {
      throw new Error(`illegal runtime transition: ${this.state} -> ${to}`);
    }
    const from = this.state;
    this.state = to;
    this.metrics.runtimeStateTransitions.push({
      from,
      to,
      at: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    });
    if (terminal.has(to)) this.metrics.terminalStateReason = reason ?? to.toLowerCase();
  }

  terminate(cancelled: boolean, reason: string) {
    if (terminal.has(this.state)) return;
    this.transition(cancelled ? 'CANCELLED' : 'FAILED', reason);
  }
}

export function allowedRuntimeTransitions(state: RuntimeState) {
  return [...allowed[state]];
}
