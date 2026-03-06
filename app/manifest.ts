import { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name:             'Mealio',
    short_name:       'Mealio',
    description:      'Save meal recipes and add ingredients to your grocery cart in one click.',
    start_url:        '/',
    display:          'standalone',
    background_color: '#ffffff',
    theme_color:      '#dd0031',
    icons: [
      { src: '/icon.png', sizes: 'any', type: 'image/png' },
    ],
  };
}
