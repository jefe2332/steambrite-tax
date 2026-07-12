
export interface TaxComponent {
  name: string;
  rate: number;
}

export interface TaxResponse {
  state: TaxComponent;
  county: TaxComponent;
  city: TaxComponent;
  districts: TaxComponent[];
  totalRate: number;
  locationName: string;
  sources: { title: string; uri: string }[];
  isLocalMatch?: boolean;
}

export interface AddressData {
  street: string;
  city: string;
  zip: string;
  state?: string;
}

export interface Suggestion {
  fullAddress: string;
  street: string;
  city: string;
  state: string;
  zip: string;
}
