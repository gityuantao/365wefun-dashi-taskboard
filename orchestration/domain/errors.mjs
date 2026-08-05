export class DomainError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}
