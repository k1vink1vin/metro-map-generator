import type { NetworkInput } from './types';

/**
 * Illustrative multimodal sample. Transfer stations may appear multiple times
 * with different station IDs. Same-name nearby duplicates are auto-grouped;
 * complexId is only needed for exceptional transfers with different names.
 */
export const sampleNetwork: NetworkInput = {
  stations: [
    { id: 'G01', name: '北機廠', lat: 24.205, lon: 120.707 },
    { id: 'G02', name: '北區', lat: 24.19, lon: 120.699 },
    { id: 'G03', name: '松竹', lat: 24.181, lon: 120.698 },
    { id: 'G04', name: '中央公園', lat: 24.165, lon: 120.681 },
    { id: 'G05', name: '市政府', lat: 24.154, lon: 120.663 },
    { id: 'G06', name: '南市場', lat: 24.139, lon: 120.652 },
    { id: 'G07', name: '大慶', lat: 24.119, lon: 120.648 },
    { id: 'G08', name: '高鐵台中', lat: 24.112, lon: 120.616, complexId: 'X_HSR' },

    { id: 'T01', name: '松竹', lat: 24.181, lon: 120.698 },
    { id: 'T02', name: '太原', lat: 24.167, lon: 120.699 },
    { id: 'T03', name: '臺中', lat: 24.137, lon: 120.686 },
    { id: 'T04', name: '五權', lat: 24.129, lon: 120.671 },
    { id: 'T05', name: '大慶', lat: 24.119, lon: 120.648 },
    { id: 'T06', name: '新烏日', lat: 24.112, lon: 120.616, complexId: 'X_HSR' },

    { id: 'B01', name: '港區支線', lat: 24.17, lon: 120.626 },
    { id: 'B02', name: '大學', lat: 24.183, lon: 120.641 },
    { id: 'B03', name: '市政府', lat: 24.154, lon: 120.663 },
  ],
  lines: [
    {
      id: 'GREEN',
      name: '捷運綠線',
      color: '#16a34a',
      paths: [
        ['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08'],
        ['G03', 'G04', 'G05', 'B02', 'B01'],
      ],
    },
    {
      id: 'RAIL',
      name: '台鐵',
      color: '#2563eb',
      paths: [['T01', 'T02', 'T03', 'T04', 'T05', 'T06']],
    },
    {
      id: 'ORANGE',
      name: '橘線',
      color: '#f97316',
      paths: [['B01', 'B02', 'B03', 'G04', 'G03']],
    },
  ],
};
