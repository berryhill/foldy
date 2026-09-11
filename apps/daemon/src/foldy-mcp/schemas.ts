import type { FoldyMcpScope } from './grants.js';

type JsonSchema = {
  type: 'object';
  properties: Record<string, Readonly<Record<string, unknown>>>;
  required?: readonly string[];
  additionalProperties: false;
};

export interface FoldyMcpToolDefinition {
  name: string;
  description: string;
  scope: FoldyMcpScope;
  inputSchema: JsonSchema;
}

const stringProperty = { type: 'string', minLength: 1 } as const;
const integerProperty = { type: 'integer', minimum: 0 } as const;
const nullableStringProperty = { type: ['string', 'null'] } as const;

export const FOLDY_MCP_TOOL_DEFINITIONS = [
  { scope: 'read', name: 'foldy_get_publication', description: 'Read the bound project publication state.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { scope: 'read', name: 'foldy_get_revision', description: 'Read one immutable revision from the bound project.', inputSchema: { type: 'object', additionalProperties: false, required: ['revisionId'], properties: { revisionId: stringProperty } } },
  { scope: 'editor', name: 'foldy_save_revision', description: 'Save the enrolled entry and project files as a new revision.', inputSchema: { type: 'object', additionalProperties: false, required: ['entryFile', 'expectedLatestRevisionId'], properties: { entryFile: stringProperty, expectedLatestRevisionId: nullableStringProperty } } },
  { scope: 'reviewer', name: 'foldy_request_review', description: 'Request review of a revision.', inputSchema: { type: 'object', additionalProperties: false, required: ['revisionId', 'expectedLatestRevisionId'], properties: { revisionId: stringProperty, expectedLatestRevisionId: stringProperty } } },
  { scope: 'reviewer', name: 'foldy_add_review_comment', description: 'Add a review comment.', inputSchema: { type: 'object', additionalProperties: false, required: ['revisionId', 'reviewId', 'body', 'expectedReviewVersion'], properties: { revisionId: stringProperty, reviewId: stringProperty, body: stringProperty, expectedReviewVersion: integerProperty } } },
  { scope: 'reviewer', name: 'foldy_decide_review', description: 'Approve or request changes on a review.', inputSchema: { type: 'object', additionalProperties: false, required: ['revisionId', 'reviewId', 'decision', 'expectedReviewVersion'], properties: { revisionId: stringProperty, reviewId: stringProperty, decision: { type: 'string', enum: ['approved', 'changes_requested'] }, expectedReviewVersion: integerProperty } } },
  { scope: 'publisher', name: 'foldy_publish', description: 'Publish an approved revision.', inputSchema: { type: 'object', additionalProperties: false, required: ['revisionId', 'expectedPublishedGeneration'], properties: { revisionId: stringProperty, expectedPublishedGeneration: integerProperty } } },
  { scope: 'publisher', name: 'foldy_rollback', description: 'Roll publication back to an immutable revision.', inputSchema: { type: 'object', additionalProperties: false, required: ['targetRevisionId', 'expectedPublishedGeneration'], properties: { targetRevisionId: stringProperty, expectedPublishedGeneration: integerProperty } } },
  { scope: 'deployer', name: 'foldy_deploy', description: 'Deploy an exact immutable revision and bundle to Cynder.', inputSchema: { type: 'object', additionalProperties: false, required: ['revisionId', 'environment', 'idempotencyKey', 'expectedActiveProviderRevisionId'], properties: { revisionId: stringProperty, environment: stringProperty, idempotencyKey: stringProperty, expectedActiveProviderRevisionId: nullableStringProperty } } },
] as const satisfies readonly FoldyMcpToolDefinition[];

export class FoldyMcpArgumentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FoldyMcpArgumentsError';
  }
}

function validProperty(value: unknown, schema: Readonly<Record<string, unknown>>): boolean {
  const type = schema.type;
  if (Array.isArray(type)) {
    return type.some((candidate) => candidate === 'null' ? value === null : candidate === 'string' ? typeof value === 'string' : false);
  }
  if (type === 'string') {
    return typeof value === 'string'
      && (typeof schema.minLength !== 'number' || value.length >= schema.minLength)
      && (!Array.isArray(schema.enum) || schema.enum.includes(value));
  }
  if (type === 'integer') {
    return Number.isSafeInteger(value)
      && (typeof schema.minimum !== 'number' || (value as number) >= schema.minimum);
  }
  return false;
}

export function validateFoldyMcpToolArguments(operation: string, value: unknown): Record<string, unknown> {
  const definition = FOLDY_MCP_TOOL_DEFINITIONS.find((candidate) => candidate.name === operation);
  if (!definition) throw new FoldyMcpArgumentsError(`unknown Foldy MCP operation: ${operation}`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FoldyMcpArgumentsError('tool arguments must be an object');
  }
  const schema: JsonSchema = definition.inputSchema;
  const input = value as Record<string, unknown>;
  const allowed = Object.keys(schema.properties);
  const extra = Object.keys(input).find((key) => !allowed.includes(key));
  if (extra) throw new FoldyMcpArgumentsError(`unexpected tool argument: ${extra}`);
  for (const required of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(input, required)) {
      throw new FoldyMcpArgumentsError(`missing required tool argument: ${required}`);
    }
  }
  for (const [name, propertySchema] of Object.entries(schema.properties)) {
    if (Object.prototype.hasOwnProperty.call(input, name) && !validProperty(input[name], propertySchema)) {
      throw new FoldyMcpArgumentsError(`invalid tool argument: ${name}`);
    }
  }
  return input;
}
