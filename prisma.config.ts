// Prisma 7 configuration file
// See: https://pris.ly/d/config-datasource
import { config } from 'dotenv';

// Load environment variables
config();

export default {
  datasource: {
    url: process.env.DATABASE_URL || '',
  },
};
