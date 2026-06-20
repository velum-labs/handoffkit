import defaultMdxComponents from "fumadocs-ui/mdx";
import { Card, Cards } from "fumadocs-ui/components/card";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { APIPage } from "fumadocs-openapi/ui";
import type { MDXComponents } from "mdx/types";

import { Mermaid } from "./components/mermaid";
import { openapi } from "./lib/openapi";

/** Merge the default Fumadocs MDX components with our custom ones. */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Card,
    Cards,
    Step,
    Steps,
    Tab,
    Tabs,
    Mermaid,
    APIPage: (props) => <APIPage {...openapi.getAPIPageProps(props)} />,
    ...components
  };
}
