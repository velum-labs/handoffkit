import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

/** Shared chrome (nav title, links) for the home and docs layouts. */
export const baseOptions: BaseLayoutProps = {
  nav: {
    title: "fusionkit"
  },
  links: [
    {
      text: "Docs",
      url: "/docs",
      active: "nested-url"
    },
    {
      text: "Tools",
      url: "/docs/tools",
      active: "nested-url"
    },
    {
      text: "Guides",
      url: "/docs/guides/inference-endpoint",
      active: "nested-url"
    },
    {
      text: "Concepts",
      url: "/docs/concepts/overview",
      active: "nested-url"
    },
    {
      text: "Reference",
      url: "/docs/reference/commands",
      active: "nested-url"
    },
    {
      text: "API",
      url: "/docs/api",
      active: "nested-url"
    },
    {
      text: "GitHub",
      url: "https://github.com/velum-labs/handoffkit"
    }
  ]
};
