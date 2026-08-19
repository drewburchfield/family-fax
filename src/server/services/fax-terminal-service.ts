import type {
  FaxNotification,
  TemporaryNumberState,
} from "../../shared/contracts";
import type { Repository } from "../repositories/types";
import type { NotificationService } from "./notification-service";
import type { NumberService } from "./number-service";

const terminalStates = new Set(["delivered", "failed", "completed", "canceled"]);

export interface FaxTerminalResult {
  notification: FaxNotification | null;
  numberState: TemporaryNumberState | null;
}

export class FaxTerminalService {
  constructor(
    private readonly dependencies: {
      repository: Repository;
      notifications: NotificationService;
      numbers: NumberService;
    },
  ) {}

  async complete(faxJobId: string): Promise<FaxTerminalResult> {
    const fax = await this.dependencies.repository.getFaxJob(faxJobId);
    if (!fax || fax.direction !== "outbound" || !terminalStates.has(fax.state)) {
      return { notification: null, numberState: null };
    }
    let notification: FaxNotification | null = null;
    let notificationError: unknown = null;
    if (fax.state === "delivered") {
      try {
        notification = await this.dependencies.notifications.deliver(
          fax.id,
          "outbound_delivered",
        );
      } catch (error) {
        notificationError = error;
        console.error(
          JSON.stringify({
            event: "fax.terminal_notification_failed",
            faxJobId: fax.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    if (!fax.temporaryNumberId) {
      if (notificationError) throw notificationError;
      return { notification, numberState: null };
    }
    const number = await this.dependencies.repository.getTemporaryNumber(fax.temporaryNumberId);
    if (!number) {
      if (notificationError) throw notificationError;
      return { notification, numberState: null };
    }
    if ((number.releasePolicy ?? "scheduled") !== "after-send" || number.state === "released") {
      if (notificationError) throw notificationError;
      return { notification, numberState: number.state };
    }
    let released: Awaited<ReturnType<NumberService["releaseNumber"]>>;
    try {
      released = await this.dependencies.numbers.releaseNumber(number.id);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "fax.terminal_number_release_failed",
          faxJobId: fax.id,
          temporaryNumberId: number.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
    if (notificationError) throw notificationError;
    return { notification, numberState: released.state };
  }
}
