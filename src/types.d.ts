/// <reference types="vite/client" />

export type Language =
    | "ru"
    | "en"
    | "hy"
    | "gr";

export interface Word {
    id: string;
    value: string;
    language: Language;
}

export interface WordEnrichment {
    synonyms?: string[];
    forms?: string[];
    examples?: { source: string; translation: string }[];
}

export interface Translation {
    id: string;
    wordId?: number;
    partOfSpeech?: string;
    englishWord: Word;
    foreignWord: Word;
    transliteration?: string;
    ttsFile?: string;
    enrichment?: WordEnrichment;
}

export interface Card {
    id: string;
    createdAt: number;
    updatedAt: number;
    wordId?: number;
    languagePair: Language[];
    translation: Translation;
    imageUrlSmall: string;
    imageUrlLarge: string;
    ttsFile?: string;
    score?: number;
}
