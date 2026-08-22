export interface Position {
  line: number;
  col: number;
}

export interface SpecValidationError {
  line: number;
  col: number;
  instancePath: string;
  message: string;
}

export interface SpecValidationResult {
  valid: boolean;
  errors: SpecValidationError[];
}

export interface ValidateOptions {
  /** Companion `datasource_types.yaml` text. Required for non-empty seeds. */
  datasourceTypes?: string;
  /** Path to companion `datasource_types.yaml`. Ignored when `datasourceTypes` is set. */
  datasourceTypesPath?: string;
  /** Absolute path of the document being validated. Set by `validateFile`. */
  includeFilePath?: string;
  /** Directory used to resolve `file:` includes. Set by `validateFile`. */
  includeBasePath?: string;
}

export interface AjvError {
  keyword: string;
  instancePath: string;
  message?: string;
  params?: Record<string, unknown>;
}

export interface ValidateFn {
  (data: unknown): boolean;
  errors?: AjvError[] | null;
}

export interface AjvLike {
  compile(schema: unknown): ValidateFn;
}
