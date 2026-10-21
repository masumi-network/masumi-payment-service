/**
 * Turns the zod issues of a failed registry-metadata parse into one readable sentence.
 *
 * The metadata schema is a union of the registry entry variants, so zod reports a failure as nested
 * `invalid_union` issues with one list of problems per variant. The most useful list is the one with the
 * fewest problems: that is the variant the metadata was most likely meant to be.
 */

type MetadataIssue = {
	code: string;
	path: PropertyKey[];
	message: string;
	errors?: MetadataIssue[][];
};

const MAX_LISTED = 5;

function leafProblems(issues: MetadataIssue[], parentPath: PropertyKey[] = []): string[] {
	return issues.flatMap((issue) => {
		const path = [...parentPath, ...issue.path];
		if (issue.code === 'invalid_union' && issue.errors && issue.errors.length > 0) {
			const branches = issue.errors.map((branch) => leafProblems(branch, path));
			return branches.reduce((closest, branch) => (branch.length < closest.length ? branch : closest));
		}
		const label = path.length > 0 ? path.map(String).join('.') : 'metadata';
		return [`${label}: ${issue.message.replace(/^Invalid input:\s*/, '')}`];
	});
}

export function describeMetadataIssues(issues: MetadataIssue[]): string {
	const problems = [...new Set(leafProblems(issues))];
	if (problems.length === 0) return 'the metadata does not match any registry entry format';
	const listed = problems.slice(0, MAX_LISTED).join('; ');
	return problems.length > MAX_LISTED ? `${listed}; and ${problems.length - MAX_LISTED} more` : listed;
}
