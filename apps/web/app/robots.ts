// /robots.txt (task 6.4; rules in lib/robots.ts).
import type { MetadataRoute } from 'next';
import { buildRobots } from '../lib/robots';

export default function robots(): MetadataRoute.Robots { return buildRobots(); }
