import { en } from './en';
import { zh } from './zh';

export type LangType = 'en' | 'zh';

const dictionaries = {
    en,
    zh,
};

export function getT(lang: LangType) {
    return dictionaries[lang];
}
