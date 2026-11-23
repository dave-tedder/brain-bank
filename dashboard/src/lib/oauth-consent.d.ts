export interface ConsentConfig {
  supabaseUrl: string;
  publicKey: string;
  ownerId: string;
  clientId: string;
}
export declare function consentResponse(config: ConsentConfig): Response;
