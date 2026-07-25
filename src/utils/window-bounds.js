const MIN_VISIBLE_AREA = 48 * 48;

function getIntersectionArea(left, right) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

function clamp(value, minimum, maximum) {
  if (maximum < minimum) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, value));
}

function resolveWindowPosition(position, size, workAreas, primaryWorkArea = null) {
  if (!position || !size || !Array.isArray(workAreas) || workAreas.length === 0) {
    return null;
  }

  const candidate = {
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
  };
  const rankedAreas = workAreas
    .map((workArea) => ({ workArea, intersectionArea: getIntersectionArea(candidate, workArea) }))
    .sort((left, right) => right.intersectionArea - left.intersectionArea);
  const bestMatch = rankedAreas[0];
  const targetArea = bestMatch.intersectionArea >= MIN_VISIBLE_AREA
    ? bestMatch.workArea
    : primaryWorkArea || workAreas[0];

  if (bestMatch.intersectionArea < MIN_VISIBLE_AREA) {
    return {
      x: Math.round(targetArea.x + Math.max(0, targetArea.width - size.width) / 2),
      y: Math.round(targetArea.y + Math.max(0, targetArea.height - size.height) / 2),
    };
  }

  return {
    x: Math.round(clamp(position.x, targetArea.x, targetArea.x + targetArea.width - size.width)),
    y: Math.round(clamp(position.y, targetArea.y, targetArea.y + targetArea.height - size.height)),
  };
}

module.exports = {
  getIntersectionArea,
  resolveWindowPosition,
};
