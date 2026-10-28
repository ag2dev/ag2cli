/**
 * Public ask identity derivation, shared by the projector (encode) and the
 * `session.resolveInteraction` handler (decode).
 *
 * The runtime ask payload carries labels only, while the public wire needs
 * stable question and option ids. Both sides therefore derive them from the
 * durable AskUserRequested event id and payload ordering; decoding always
 * recomputes the candidate ids instead of parsing the string, so the ids
 * never acquire a grammar and an unknown id is simply no candidate's match.
 */

export function askQuestionId(interactionId: string, questionIndex: number): string {
  return `${interactionId}:q${questionIndex}`
}

export function askOptionId(questionId: string, optionIndex: number): string {
  return `${questionId}:o${optionIndex}`
}
