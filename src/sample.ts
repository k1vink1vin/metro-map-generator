import type { NetworkInput } from './types';

/**
 * Illustrative multimodal sample. Transfer stations may appear multiple times
 * with different station IDs. Same-name nearby duplicates are auto-grouped;
 * complexId is only needed for exceptional transfers with different names.
 */
export const sampleNetwork: NetworkInput = {
  stations: [
    { id: 'G01', name: 'North Depot', lat: 24.205, lon: 120.707 },
    { id: 'G02', name: 'North District', lat: 24.19, lon: 120.699 },
    { id: 'G03', name: 'Songzhu', lat: 24.181, lon: 120.698 },
    { id: 'G04', name: 'Central Park', lat: 24.165, lon: 120.681 },
    { id: 'G05', name: 'City Hall', lat: 24.154, lon: 120.663 },
    { id: 'G06', name: 'South Market', lat: 24.139, lon: 120.652 },
    { id: 'G07', name: 'Daqing', lat: 24.119, lon: 120.648 },
    { id: 'G08', name: 'HSR Taichung', lat: 24.112, lon: 120.616, complexId: 'X_HSR' },

    { id: 'T01', name: 'Songzhu', lat: 24.1815, lon: 120.699 },
    { id: 'T02', name: 'Taiyuan', lat: 24.167, lon: 120.699 },
    { id: 'T03', name: 'Taichung', lat: 24.137, lon: 120.686 },
    { id: 'T04', name: 'Wuquan', lat: 24.129, lon: 120.671 },
    { id: 'T05', name: 'Daqing', lat: 24.1195, lon: 120.649 },
    { id: 'T06', name: 'Xinwuri', lat: 24.111, lon: 120.615, complexId: 'X_HSR' },

    { id: 'B01', name: 'Harbor Branch', lat: 24.17, lon: 120.626 },
    { id: 'B02', name: 'University', lat: 24.183, lon: 120.641 },
  ],
  lines: [
    {
      id: 'GREEN',
      name: 'Metro Green',
      color: '#16a34a',
      paths: [
        ['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08'],
        ['G03', 'G04', 'G05', 'B02', 'B01'],
      ],
    },
    {
      id: 'RAIL',
      name: 'Regional Rail',
      color: '#2563eb',
      paths: [['T01', 'T02', 'T03', 'T04', 'T05', 'T06']],
    },
    {
      id: 'ORANGE',
      name: 'Orange Line',
      color: '#f97316',
      paths: [['B01', 'B02', 'G05', 'G04', 'G03']],
    },
  ],
};
