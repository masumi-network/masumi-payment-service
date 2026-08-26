import { chmod, mkdtemp, open, rm, stat, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Zip, ZipDeflate } from 'fflate';

const REPORT_EXPORT_TEMP_PREFIX = 'masumi-report-';
const DOWNLOAD_BASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export const REPORT_CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
export const REPORT_ZIP_CONTENT_TYPE = 'application/zip';

export type StagedReportArtifact = {
	filePath: string;
	filename: string;
	contentType: typeof REPORT_CSV_CONTENT_TYPE | typeof REPORT_ZIP_CONTENT_TYPE;
	contentLength: number;
	cleanup: () => Promise<void>;
};

export type ReportCsvFiles = {
	transactions: Buffer;
	walletSummary: Buffer;
	totals: Buffer;
};

type ArtifactWriter = (filePath: string) => Promise<void>;

function validateDownloadBaseName(downloadBaseName: string): void {
	if (!DOWNLOAD_BASE_NAME_PATTERN.test(downloadBaseName)) {
		throw new TypeError(
			'Download base name must contain 1 to 100 ASCII letters, digits, underscores, or hyphens and start with a letter or digit',
		);
	}
}

function createCleanup(tempDirectory: string): () => Promise<void> {
	let cleanupPromise: Promise<void> | null = null;

	return () => {
		cleanupPromise ??= rm(tempDirectory, { recursive: true, force: true });
		return cleanupPromise;
	};
}

async function writeBufferExclusive(filePath: string, content: Buffer): Promise<void> {
	let fileHandle: FileHandle | null = null;

	try {
		fileHandle = await open(filePath, 'wx', PRIVATE_FILE_MODE);
		await fileHandle.writeFile(content);
		await fileHandle.sync();
	} finally {
		await fileHandle?.close();
	}
}

async function writeZipExclusive(filePath: string, files: ReportCsvFiles): Promise<void> {
	const fileHandle = await open(filePath, 'wx', PRIVATE_FILE_MODE);
	let pendingWrite = Promise.resolve();
	let resolveArchive: (() => void) | null = null;
	let rejectArchive: ((error: unknown) => void) | null = null;
	const archiveComplete = new Promise<void>((resolve, reject) => {
		resolveArchive = resolve;
		rejectArchive = reject;
	});
	const archive = new Zip((error, data, final) => {
		if (error != null) {
			rejectArchive?.(error);
			return;
		}

		const chunk = Buffer.from(data);
		pendingWrite = pendingWrite.then(async () => {
			await fileHandle.writeFile(chunk);
		});

		if (final) {
			void pendingWrite.then(
				() => resolveArchive?.(),
				(error_) => rejectArchive?.(error_),
			);
		}
	});

	try {
		for (const [filename, content] of [
			['transactions.csv', files.transactions],
			['wallet-summary.csv', files.walletSummary],
			['totals.csv', files.totals],
		] as const) {
			const member = new ZipDeflate(filename);
			archive.add(member);
			member.push(content, true);
		}
		archive.end();
		await archiveComplete;
		await fileHandle.sync();
	} catch (error) {
		archive.terminate();
		await pendingWrite.catch(() => undefined);
		throw error;
	} finally {
		await fileHandle.close();
	}
}

async function stageArtifact(
	downloadBaseName: string,
	extension: 'csv' | 'zip',
	contentType: StagedReportArtifact['contentType'],
	writeArtifact: ArtifactWriter,
): Promise<StagedReportArtifact> {
	validateDownloadBaseName(downloadBaseName);

	const tempDirectory = await mkdtemp(join(tmpdir(), REPORT_EXPORT_TEMP_PREFIX));
	const cleanup = createCleanup(tempDirectory);
	const filename = `${downloadBaseName}.${extension}`;
	const filePath = join(tempDirectory, filename);

	try {
		await chmod(tempDirectory, PRIVATE_DIRECTORY_MODE);
		await writeArtifact(filePath);
		await chmod(filePath, PRIVATE_FILE_MODE);
		const fileStats = await stat(filePath);
		if (!fileStats.isFile()) {
			throw new Error('Staged report artifact is not a regular file');
		}

		return {
			filePath,
			filename,
			contentType,
			contentLength: fileStats.size,
			cleanup,
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}

export async function stageReportCsv(csv: Buffer, downloadBaseName: string): Promise<StagedReportArtifact> {
	return stageArtifact(downloadBaseName, 'csv', REPORT_CSV_CONTENT_TYPE, async (filePath) => {
		await writeBufferExclusive(filePath, csv);
	});
}

export async function stageReportZip(files: ReportCsvFiles, downloadBaseName: string): Promise<StagedReportArtifact> {
	return stageArtifact(downloadBaseName, 'zip', REPORT_ZIP_CONTENT_TYPE, async (filePath) => {
		await writeZipExclusive(filePath, files);
	});
}
