// Re-export of the shared, pure deliverability heuristics. The implementation
// moved to shared/ so the server engine's anti-slop verifier uses the same
// rules; this file stays as the frontend's stable import path.
export {
  checkDeliverability,
  type DeliverabilityLevel,
  type DeliverabilityResult,
} from '../../shared/deliverability';
