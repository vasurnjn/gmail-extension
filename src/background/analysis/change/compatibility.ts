/**
 * Determines whether two known topic scopes are semantically compatible.
 * Conservative safety rule: Distinct roles, processes, or transaction IDs must NEVER merge.
 */
export function isTopicCompatible(
  topicA: string | null | undefined,
  topicB: string | null | undefined
): boolean {
  if (!topicA || !topicB) return false;
  const a = topicA.trim().toLowerCase().replace(/\s+/g, '_');
  const b = topicB.trim().toLowerCase().replace(/\s+/g, '_');

  // Exact match
  if (a === b) return true;

  // Known career / recruitment roles
  const knownRoles = [
    'software_engineer',
    'data_analyst',
    'data_scientist',
    'product_manager',
    'business_analyst',
    'internship',
    'role_ai',
    'role_software',
    'ai_role',
    'software_role',
  ];
  const roleA = knownRoles.find((r) => a.includes(r));
  const roleB = knownRoles.find((r) => b.includes(r));

  // If both explicitly specify known roles and they differ: incompatible
  if (roleA && roleB) {
    return roleA === roleB;
  }

  // Any explicit role_ prefix comparison (e.g. role_ai vs role_software)
  if (a.startsWith('role_') && b.startsWith('role_')) {
    return a === b;
  }

  // Known processes / event types
  const knownProcesses = ['recruitment', 'hackathon', 'symposium', 'webinar'];
  const procA = knownProcesses.find((p) => a.includes(p));
  const procB = knownProcesses.find((p) => b.includes(p));

  // If both explicitly specify processes and they differ: incompatible
  if (procA && procB && procA !== procB) {
    return false;
  }

  // If one topic is a role (e.g. software_engineer) and other is composite with same role (e.g. recruitment_software_engineer)
  if (roleA && (b === roleA || a.endsWith(`_${b}`))) {
    return true;
  }
  if (roleB && (a === roleB || b.endsWith(`_${a}`))) {
    return true;
  }

  // Identifiers: order, course, pnr, flight
  const isIdentifierA = /^(?:order|course|pnr|flight)_/.test(a);
  const isIdentifierB = /^(?:order|course|pnr|flight)_/.test(b);
  if (isIdentifierA || isIdentifierB) {
    return a === b;
  }

  // If both have the same process and neither has a conflicting role
  if (procA && procB && procA === procB && !roleA && !roleB) {
    return true;
  }

  return false;
}
