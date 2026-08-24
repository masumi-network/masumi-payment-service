export const REPORT_CHART_POINT_LIMIT = 240;
export const REPORT_TABLE_PAGE_SIZE = 50;

type ChartPoint = Readonly<{ y: number; isUnknown?: boolean }>;

function decimateKnownChartPoints<T extends ChartPoint>(
  points: readonly T[],
  limit: number,
): readonly T[] {
  if (points.length <= limit) return points;
  if (limit < 4) return [points[0], points.at(-1)!];

  const result: T[] = [points[0]];
  const interiorLength = points.length - 2;
  const bucketCount = Math.floor((limit - 2) / 2);

  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const start = 1 + Math.floor((interiorLength * bucketIndex) / bucketCount);
    const end = 1 + Math.floor((interiorLength * (bucketIndex + 1)) / bucketCount);
    let minIndex = start;
    let maxIndex = start;

    for (let pointIndex = start + 1; pointIndex < end; pointIndex += 1) {
      if (points[pointIndex].y < points[minIndex].y) minIndex = pointIndex;
      if (points[pointIndex].y > points[maxIndex].y) maxIndex = pointIndex;
    }

    if (minIndex === maxIndex) {
      result.push(points[minIndex]);
    } else if (minIndex < maxIndex) {
      result.push(points[minIndex], points[maxIndex]);
    } else {
      result.push(points[maxIndex], points[minIndex]);
    }
  }

  result.push(points.at(-1)!);
  return result;
}

export function decimateReportChartPoints<T extends ChartPoint>(
  points: readonly T[],
  requestedLimit = REPORT_CHART_POINT_LIMIT,
): readonly T[] {
  const limit = Math.max(2, Math.floor(requestedLimit));
  if (points.length <= limit) return points;

  const knownPoints = points.filter((point) => !point.isUnknown);
  if (knownPoints.length === 0) return points.length === 0 ? [] : [points[0]];

  const visibleKnownPoints = decimateKnownChartPoints(knownPoints, limit);
  const sourceIndexes = new Map(points.map((point, index) => [point, index]));
  const result: T[] = [];
  let previousSourceIndex: number | undefined;

  for (const point of visibleKnownPoints) {
    const sourceIndex = sourceIndexes.get(point)!;
    if (previousSourceIndex != null) {
      const gap = points
        .slice(previousSourceIndex + 1, sourceIndex)
        .find((candidate) => candidate.isUnknown);
      if (gap) result.push(gap);
    }
    result.push(point);
    previousSourceIndex = sourceIndex;
  }

  return result;
}

export type ReportRowPage<T> = Readonly<{
  items: readonly T[];
  page: number;
  pageCount: number;
  startIndex: number;
  endIndex: number;
  totalCount: number;
}>;

export type ReportTablePageState = Readonly<{
  dataset: object;
  page: number;
}>;

export function resetReportTablePageState(
  state: ReportTablePageState,
  dataset: object,
): ReportTablePageState {
  return state.dataset === dataset ? state : { dataset, page: 0 };
}

export function paginateReportRows<T>(
  rows: readonly T[],
  requestedPage: number,
  requestedPageSize = REPORT_TABLE_PAGE_SIZE,
): ReportRowPage<T> {
  const pageSize = Math.max(1, Math.floor(requestedPageSize));
  const pageCount = Math.ceil(rows.length / pageSize);
  const page =
    pageCount === 0 ? 0 : Math.min(Math.max(0, Math.floor(requestedPage)), pageCount - 1);
  const startIndex = page * pageSize;
  const endIndex = Math.min(startIndex + pageSize, rows.length);
  return {
    items: rows.slice(startIndex, endIndex),
    page,
    pageCount,
    startIndex,
    endIndex,
    totalCount: rows.length,
  };
}
