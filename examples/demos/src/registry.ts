export type Demo = {
  id: string;
  title: string;
  summary: string;
  /** Demos that keep a server running and wait for Ctrl+C. */
  interactive?: boolean;
  run(): Promise<void>;
};
