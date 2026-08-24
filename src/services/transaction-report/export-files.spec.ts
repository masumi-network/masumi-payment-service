import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { unzipSync } from 'fflate';
import { REPORT_CSV_CONTENT_TYPE, REPORT_ZIP_CONTENT_TYPE, stageReportCsv, stageReportZip } from './export-files';

const csvFiles = {
	transactions: Buffer.from('id,amount\r\ntransaction-1,1000000\r\n', 'utf8'),
	walletSummary: Buffer.from('wallet_id,revenue\r\nwallet-1,950000\r\n', 'utf8'),
	totals: Buffer.from('gross,fees,net\r\n1000000,50000,950000\r\n', 'utf8'),
};

describe('stageReportCsv', () => {
	it('stages an exact private CSV file and reports its metadata', async () => {
		const csv = Buffer.from('name,value\r\nAda,1.000000\r\n', 'utf8');
		const artifact = await stageReportCsv(csv, 'transactions-20260824');

		try {
			expect(artifact.filename).toBe('transactions-20260824.csv');
			expect(artifact.contentType).toBe(REPORT_CSV_CONTENT_TYPE);
			expect(artifact.contentLength).toBe(csv.byteLength);
			expect(await readFile(artifact.filePath)).toEqual(csv);

			const directoryStats = await stat(dirname(artifact.filePath));
			const fileStats = await stat(artifact.filePath);
			expect(directoryStats.mode & 0o777).toBe(0o700);
			expect(fileStats.mode & 0o777).toBe(0o600);
		} finally {
			await artifact.cleanup();
		}
	});

	it('cleans staged data idempotently', async () => {
		const artifact = await stageReportCsv(Buffer.from('value\r\n1\r\n'), 'totals');
		const tempDirectory = dirname(artifact.filePath);

		await Promise.all([artifact.cleanup(), artifact.cleanup(), artifact.cleanup()]);
		await expect(access(tempDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(artifact.cleanup()).resolves.toBeUndefined();
	});
});

describe('stageReportZip', () => {
	it('stages exactly three CSV members without changing their bytes', async () => {
		const artifact = await stageReportZip(csvFiles, 'financial-report');

		try {
			const zipBytes = await readFile(artifact.filePath);
			const members = unzipSync(zipBytes);

			expect(Object.keys(members).sort()).toEqual(['totals.csv', 'transactions.csv', 'wallet-summary.csv']);
			expect(Buffer.from(members['transactions.csv'])).toEqual(csvFiles.transactions);
			expect(Buffer.from(members['wallet-summary.csv'])).toEqual(csvFiles.walletSummary);
			expect(Buffer.from(members['totals.csv'])).toEqual(csvFiles.totals);
			expect(artifact.filename).toBe('financial-report.zip');
			expect(artifact.contentType).toBe(REPORT_ZIP_CONTENT_TYPE);
			expect(artifact.contentLength).toBe(zipBytes.byteLength);
		} finally {
			await artifact.cleanup();
		}
	});

	it('removes staged temp data when ZIP creation fails', async () => {
		const isolatedTempRoot = await mkdtemp(join(tmpdir(), 'masumi-export-failure-test-'));
		const previousTempDirectory = process.env.TMPDIR;

		try {
			process.env.TMPDIR = isolatedTempRoot;
			await expect(
				stageReportZip(
					{
						...csvFiles,
						transactions: null as unknown as Buffer,
					},
					'failed-report',
				),
			).rejects.toThrow();
			expect(await readdir(isolatedTempRoot)).toEqual([]);
		} finally {
			if (previousTempDirectory == null) {
				delete process.env.TMPDIR;
			} else {
				process.env.TMPDIR = previousTempDirectory;
			}
			await rm(isolatedTempRoot, { recursive: true, force: true });
		}
	});
});

describe('report export download base names', () => {
	it.each([
		'',
		'.',
		'../report',
		'report.csv',
		'report name',
		'_report',
		'report/child',
		'report\\child',
		'a'.repeat(101),
	])('rejects invalid base name %j before staging', async (downloadBaseName) => {
		await expect(stageReportCsv(Buffer.alloc(0), downloadBaseName)).rejects.toThrow(TypeError);
		await expect(stageReportZip(csvFiles, downloadBaseName)).rejects.toThrow(TypeError);
	});

	it.each(['r', 'Report_2026-08-24', 'transactions'])('accepts valid base name %j', async (downloadBaseName) => {
		const artifact = await stageReportCsv(Buffer.alloc(0), downloadBaseName);

		try {
			expect(artifact.filename).toBe(`${downloadBaseName}.csv`);
		} finally {
			await artifact.cleanup();
		}
	});
});
