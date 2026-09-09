import mongoose from 'mongoose';
import { env } from './env';

let connected = false;

export async function connectDb(): Promise<void> {
  if (connected) return;
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongoUri);
  connected = true;
  // eslint-disable-next-line no-console
  console.log(`[db] connected -> ${env.mongoUri}`);
}

export async function disconnectDb(): Promise<void> {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}
