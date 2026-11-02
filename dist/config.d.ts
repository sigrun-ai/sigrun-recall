export interface SettingsReader {
    get(): Promise<Record<string, unknown>>;
}
export interface RecallSettings {
    externalizeBytes: number;
    embedding?: {
        url: string;
        model: string;
        local: boolean;
        timeoutMs: number;
    };
}
export interface UserRecallSettings {
    autoRecall: boolean;
    localProviders: readonly string[];
}
export declare function resolveSettings(store: SettingsReader): Promise<RecallSettings>;
export declare function resolveUserSettings(store: SettingsReader): Promise<UserRecallSettings>;
