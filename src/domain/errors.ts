export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(entity: "fax" | "number", from: string, to: string) {
    super(`Invalid ${entity} transition: ${from} -> ${to}`, "invalid_transition", 409, {
      entity,
      from,
      to,
    });
    this.name = "InvalidTransitionError";
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id: string) {
    super(`${entity} not found`, "not_found", 404, { entity, id });
    this.name = "NotFoundError";
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "conflict", 409, details);
    this.name = "ConflictError";
  }
}

export class AuthenticationError extends DomainError {
  constructor(message = "Authentication is required.") {
    super(message, "authentication_required", 401);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends DomainError {
  constructor(message = "This request is not allowed.") {
    super(message, "forbidden", 403);
    this.name = "AuthorizationError";
  }
}

export class ProviderError extends DomainError {
  constructor(
    message: string,
    readonly providerCode: string,
    readonly retryable: boolean,
    details?: Record<string, unknown>,
  ) {
    super(message, "provider_error", 502, details);
    this.name = "ProviderError";
  }
}
