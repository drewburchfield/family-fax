import { ZodError } from "zod";

import { DomainError } from "../../domain/errors";

export function problemResponse(error: unknown, correlationId: string): Response {
  if (error instanceof DomainError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          correlationId,
        },
      },
      { status: error.status },
    );
  }
  if (error instanceof ZodError) {
    return Response.json(
      {
        error: {
          code: "invalid_request",
          message: "The request contains invalid or missing values.",
          details: { issues: error.issues },
          correlationId,
        },
      },
      { status: 400 },
    );
  }
  return Response.json(
    {
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
        correlationId,
      },
    },
    { status: 500 },
  );
}
