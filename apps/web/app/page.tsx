// Home (product.md §5.1).
import { HomeSections } from '../components/home/HomeSections';
import { loadHome } from '../lib/api';

export const revalidate = 60;

export default async function HomePage() {
  const { home } = await loadHome();
  return <HomeSections home={home} />;
}
