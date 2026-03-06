import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Simple, transparent pricing for Mealio. Free during beta — save meal recipes and add ingredients to your grocery cart in one click.',
};

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
