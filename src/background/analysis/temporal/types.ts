import {
  ActionType,
  DatePrecision,
  ExtractedTemporalEntity,
  TemporalAnalysis,
  TemporalConfidence,
  TemporalStatus,
  TemporalType,
  TimePrecision,
} from '../../../shared/types';

export type {
  ActionType,
  DatePrecision,
  ExtractedTemporalEntity,
  TemporalAnalysis,
  TemporalConfidence,
  TemporalStatus,
  TemporalType,
  TimePrecision,
};

export interface ParsedDateComponent {
  year: number | null;
  month: number; // 1 - 12
  day: number;   // 1 - 31
  isExplicitYear: boolean;
}

export interface ParsedTimeComponent {
  hours: number;   // 0 - 23
  minutes: number; // 0 - 59
  seconds?: number;
  isExplicitTime: boolean;
  timezoneOffsetMinutes?: number | null; // e.g. +330 for +05:30, -240 for -04:00
  timezoneRaw?: string;
  isAmbiguousTimezone?: boolean;
}

export interface IntermediateTemporalCandidate {
  rawText: string;
  contextSnippet: string;
  dateComponent: ParsedDateComponent | null;
  timeComponent: ParsedTimeComponent | null;
  prepositionText?: string;
  actionVerbText?: string;
  isRelative: boolean;
  relativeType?: 'today' | 'tomorrow' | 'yesterday' | 'within_hours' | 'within_days' | 'day_of_week';
  relativeValue?: number;
  rangeEndComponent?: {
    date: ParsedDateComponent | null;
    time: ParsedTimeComponent | null;
  };
  isRange: boolean;
  isOpenEnded?: boolean;
  isCommercial: boolean;
}
