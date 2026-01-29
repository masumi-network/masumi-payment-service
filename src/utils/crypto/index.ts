import crypto from 'crypto';

const generateSHA256Hash = (data: string) => {
	return crypto.createHash('sha256').update(data).digest('hex');
};

export { generateSHA256Hash };
