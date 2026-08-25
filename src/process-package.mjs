function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireNonemptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`);
}

export function normalizeProcessPackage(value, label = 'Process Package') {
  const processPackage = requireObject(value, label);
  requireNonemptyString(processPackage.reference, `${label}.reference`);
  if (!/^sha256:[0-9a-f]{64}$/.test(processPackage.digest ?? '')) throw new Error(`${label}.digest is invalid`);
  requireNonemptyString(processPackage.language, `${label}.language`);

  const hasId = Object.hasOwn(processPackage, 'id');
  const hasVersion = Object.hasOwn(processPackage, 'version');
  if (hasId || hasVersion) {
    requireNonemptyString(processPackage.id, `${label}.id`);
    requireNonemptyString(processPackage.version, `${label}.version`);
    if (`${processPackage.id}@${processPackage.version}` !== processPackage.reference) {
      throw new Error(`${label}.id and ${label}.version do not compose to ${label}.reference`);
    }
  }

  return {
    reference: processPackage.reference,
    digest: processPackage.digest,
    language: processPackage.language,
  };
}

export function sameProcessPackageIdentity(left, right) {
  try {
    const normalizedLeft = normalizeProcessPackage(left);
    const normalizedRight = normalizeProcessPackage(right);
    return normalizedLeft.reference === normalizedRight.reference &&
      normalizedLeft.digest === normalizedRight.digest &&
      normalizedLeft.language === normalizedRight.language;
  } catch {
    return false;
  }
}
