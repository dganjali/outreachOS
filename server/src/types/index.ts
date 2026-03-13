import type { Request } from 'express';

export type ApiSuccess<T> = { success: true; data: T };
export type ApiError = { success: false; error: string };
export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export type AuthedRequest = Request & {
  session: Request['session'] & { userId?: string };
};

