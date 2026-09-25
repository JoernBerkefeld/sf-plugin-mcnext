const SALESFORCE_ALIAS_OR_USERNAME = /^(?!-)[A-Za-z0-9_.@-]+$/;

/** Validate a private NUT org alias or username without accepting shell metacharacters. */
export function requirePrivateNutAlias(value: string | undefined): string {
  if (!value || !SALESFORCE_ALIAS_OR_USERNAME.test(value)) {
    throw new Error('SF_PLUGIN_MCNEXT_NUT_ORG_ALIAS must be a safe Salesforce alias or username before opt-in');
  }
  return value;
}

/** Validate another private NUT input against its narrow contract. */
export function requirePrivateNutValue(name: string, value: string | undefined, pattern: RegExp): string {
  if (!value || !pattern.test(value)) throw new Error(`${name} must be set to a valid private NUT value before opt-in`);
  return value;
}
