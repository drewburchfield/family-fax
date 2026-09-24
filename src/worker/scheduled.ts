import type { Clock } from "../domain/clock";
import type { Repository } from "../server/repositories/types";
import { sanitizeDiagnosticValue, type AuditService } from "../server/services/audit-service";
import type { FaxService } from "../server/services/fax-service";
import type { FaxTerminalService } from "../server/services/fax-terminal-service";
import type { NotificationService } from "../server/services/notification-service";
import type { NumberService } from "../server/services/number-service";
import type { FaxJob, TemporaryNumber } from "../shared/contracts";
import type { WorkerEnv } from "./env";
import { createServiceContainer } from "./services";

export async function runSafetySweep(dependencies: {
  repository: Repository;
  numbers: NumberService;
  fax: FaxService;
  audit: AuditService;
  clock: Clock;
  terminal?: Pick<FaxTerminalService, "complete">;
  notifications?: NotificationService;
}): Promise<{
  inspected: number;
  released: number;
  deferred: number;
  failed: number;
  recoveredNumberRequests: number;
  numberRequestRecoveryFailed: number;
  reconciledFaxes: number;
  reconcileFailed: number;
  reconciledNumbers: number;
  numberReconcileFailed: number;
}> {
  const timestamp = dependencies.clock.now().toISOString();
  const stuckBefore = new Date(dependencies.clock.now().getTime() - 15 * 60_000).toISOString();
  const uncertainNotifications = dependencies.notifications
    ? await dependencies.notifications.markStaleSendingUnknown(stuckBefore)
    : 0;
  const stuckNumberRequestBefore = new Date(dependencies.clock.now().getTime() - 30 * 60_000).toISOString();
  const [stuckFaxes, stuckNumberRequests, stuckReleases, activeNumbers, releasedNeedingFinalization] = await Promise.all([
    dependencies.repository.listStuckFaxJobs(stuckBefore),
    dependencies.repository.listStuckNumberRequests(stuckNumberRequestBefore),
    dependencies.repository.listStuckReleasingNumbers(stuckBefore),
    dependencies.repository.listActiveNumbers(),
    dependencies.repository.listReleasedNumbersNeedingFinalization(),
  ]);
  let reconciledNumbers = 0;
  let numberReconcileFailed = 0;
  const unreconciledNumberIds = new Set<string>();
  for (const number of activeNumbers.filter((item) => ["active", "expiring"].includes(item.state))) {
    try {
      await dependencies.numbers.reconcileActiveNumber(number.id);
      reconciledNumbers += 1;
    } catch (error) {
      numberReconcileFailed += 1;
      unreconciledNumberIds.add(number.id);
      await recordNumberSweepFailure(
        dependencies,
        number,
        "number.reconcile_failed",
        "active reconciliation",
        error,
      );
    }
  }
  const overdue = await dependencies.repository.listOverdueNumbers(timestamp);
  let released = 0;
  let deferred = 0;
  let failed = 0;
  for (const number of releasedNeedingFinalization) {
    try {
      await dependencies.numbers.finalizeReleasedNumber(number.id);
    } catch (error) {
      failed += 1;
      await recordNumberSweepFailure(
        dependencies,
        number,
        "number.release_sweep_failed",
        "released-number finalization",
        error,
      );
    }
  }
  for (const number of overdue.filter((item) => !unreconciledNumberIds.has(item.id))) {
    try {
      const result = await dependencies.numbers.releaseNumber(number.id);
      if (result.state === "released") released += 1;
      else deferred += 1;
    } catch (error) {
      failed += 1;
      await recordNumberSweepFailure(
        dependencies,
        number,
        "number.release_sweep_failed",
        "overdue release",
        error,
      );
    }
  }
  for (const number of stuckReleases) {
    try {
      const result = await dependencies.numbers.retryStuckRelease(number.id);
      if (result.state === "released") released += 1;
      else deferred += 1;
    } catch (error) {
      failed += 1;
      await recordNumberSweepFailure(
        dependencies,
        number,
        "number.release_sweep_failed",
        "stuck release recovery",
        error,
      );
    }
  }
  let recoveredNumberRequests = 0;
  let numberRequestRecoveryFailed = 0;
  for (const number of stuckNumberRequests) {
    try {
      const message = "The provisioning workflow stopped before the number became active.";
      if (number.state === "activating") await dependencies.numbers.recoverStuckActivation(number.id);
      else if (number.state === "cleaning") await dependencies.numbers.failProvisioning(number.id, message);
      else if (number.e164) await dependencies.numbers.failProvisioning(number.id, message);
      else await dependencies.numbers.abortNumberRequest(number.id, message);
      recoveredNumberRequests += 1;
    } catch {
      numberRequestRecoveryFailed += 1;
    }
  }
  let reconciledFaxes = 0;
  let reconcileFailed = 0;
  for (const job of stuckFaxes) {
    try {
      const reconciled = await dependencies.fax.reconcileOutbound(job.id);
      reconciledFaxes += 1;
      if (dependencies.terminal && ["delivered", "failed", "completed", "canceled"].includes(reconciled.state)) {
        const terminal = await dependencies.terminal.complete(reconciled.id);
        if (terminal.numberState === "released") released += 1;
        else if (terminal.numberState === "expiring") deferred += 1;
        else if (terminal.numberState === "release_failed") failed += 1;
      } else if (reconciled.temporaryNumberId && ["delivered", "failed", "completed", "canceled"].includes(reconciled.state)) {
        const number = await dependencies.repository.getTemporaryNumber(reconciled.temporaryNumberId);
        if (
          number &&
          (number.releasePolicy ?? (number.mode === "send-only" ? "after-send" : "scheduled")) === "after-send" &&
          number.state !== "released"
        ) {
          try {
            const result = await dependencies.numbers.releaseNumber(number.id);
            if (result.state === "released") released += 1;
            else deferred += 1;
          } catch (error) {
            failed += 1;
            await recordNumberSweepFailure(
              dependencies,
              number,
              "number.release_sweep_failed",
              "terminal fax release",
              error,
            );
          }
        }
      }
    } catch (error) {
      reconcileFailed += 1;
      const durable = await dependencies.repository.getFaxJob(job.id).catch(() => null);
      if (
        durable &&
        dependencies.terminal &&
        ["delivered", "failed", "completed", "canceled"].includes(durable.state)
      ) {
        try {
          const terminal = await dependencies.terminal.complete(durable.id);
          if (terminal.numberState === "released") released += 1;
          else if (terminal.numberState === "expiring") deferred += 1;
          else if (terminal.numberState === "release_failed") failed += 1;
        } catch (terminalError) {
          failed += 1;
          await recordFaxSweepFailure(
            dependencies,
            durable,
            "terminal recovery",
            terminalError,
          );
        }
      }
      await recordFaxSweepFailure(
        dependencies,
        durable ?? job,
        "provider reconciliation",
        error,
      );
    }
  }
  await dependencies.repository.setSetting("lastScheduledSweep", timestamp, timestamp);
  await dependencies.audit.record({
    correlationId: `scheduled-${timestamp}`,
    source: "scheduled",
    type: "lifecycle.safety_sweep",
    details: {
      inspected: activeNumbers.length + overdue.length + stuckReleases.length + stuckNumberRequests.length + stuckFaxes.length + releasedNeedingFinalization.length,
      released,
      deferred,
      failed,
      stuckReleases: stuckReleases.length,
      stuckNumberRequests: stuckNumberRequests.length,
      recoveredNumberRequests,
      numberRequestRecoveryFailed,
      stuckFaxes: stuckFaxes.length,
      reconciledFaxes,
      reconcileFailed,
      reconciledNumbers,
      numberReconcileFailed,
      uncertainNotifications,
    },
  });
  return {
    inspected: activeNumbers.length + overdue.length + stuckReleases.length + stuckNumberRequests.length + stuckFaxes.length + releasedNeedingFinalization.length,
    released,
    deferred,
    failed,
    recoveredNumberRequests,
    numberRequestRecoveryFailed,
    reconciledFaxes,
    reconcileFailed,
    reconciledNumbers,
    numberReconcileFailed,
  };
}

async function recordFaxSweepFailure(
  dependencies: {
    audit: AuditService;
  },
  fax: FaxJob,
  phase: string,
  error: unknown,
): Promise<void> {
  try {
    await dependencies.audit.record({
      correlationId: fax.correlationId,
      faxJobId: fax.id,
      temporaryNumberId: fax.temporaryNumberId,
      source: "scheduled",
      type: "fax.reconcile_sweep_failed",
      resultingState: fax.state,
      details: {
        phase,
        providerFaxId: fax.providerFaxId,
        error: error instanceof Error ? error.message : "Fax reconciliation failed.",
      },
    });
  } catch (failureAuditError) {
    const telemetry = sanitizeDiagnosticValue({
      event: "lifecycle.fax_failure_audit_failed",
      faxJobId: fax.id,
      correlationId: fax.correlationId,
      temporaryNumberId: fax.temporaryNumberId,
      providerFaxId: fax.providerFaxId,
      phase,
      reconciliationError: error instanceof Error ? error.message : "Fax reconciliation failed.",
      failureAuditError: failureAuditError instanceof Error
        ? failureAuditError.message
        : "Failure audit could not be recorded.",
    });
    try {
      console.error(JSON.stringify(telemetry));
    } catch {
      // The sweep must continue even when its last-resort telemetry sink is unavailable.
    }
  }
}

async function recordNumberSweepFailure(
  dependencies: {
    repository: Repository;
    audit: AuditService;
  },
  number: TemporaryNumber,
  type: "number.reconcile_failed" | "number.release_sweep_failed",
  phase: string,
  error: unknown,
): Promise<void> {
  try {
    const current = await dependencies.repository.getTemporaryNumber(number.id) ?? number;
    const job = current.faxJobId
      ? await dependencies.repository.getFaxJob(current.faxJobId)
      : null;
    await dependencies.audit.record({
      correlationId: job?.correlationId ?? current.id,
      faxJobId: current.faxJobId,
      temporaryNumberId: current.id,
      source: "scheduled",
      type,
      resultingState: current.state,
      details: {
        phase,
        e164: current.e164,
        providerName: current.providerName ?? null,
        error: error instanceof Error ? error.message : "Number lifecycle operation failed.",
      },
    });
  } catch (failureAuditError) {
    const telemetry = sanitizeDiagnosticValue({
      event: "lifecycle.number_failure_audit_failed",
      temporaryNumberId: number.id,
      faxJobId: number.faxJobId,
      providerName: number.providerName ?? null,
      e164: number.e164,
      type,
      phase,
      lifecycleError: error instanceof Error
        ? error.message
        : "Number lifecycle operation failed.",
      failureAuditError: failureAuditError instanceof Error
        ? failureAuditError.message
        : "Failure audit could not be recorded.",
    });
    try {
      console.error(JSON.stringify(telemetry));
    } catch {
      // The sweep must continue even when its last-resort telemetry sink is unavailable.
    }
  }
}

export async function handleScheduled(env: WorkerEnv): Promise<void> {
  const services = createServiceContainer(env);
  const result = await runSafetySweep({
    repository: services.repository,
    numbers: services.numbers,
    fax: services.fax,
    audit: services.audit,
    clock: { now: () => new Date() },
    terminal: services.terminal,
    notifications: services.notifications,
  });
  console.log(JSON.stringify({ event: "lifecycle.safety_sweep", ...result }));
}
