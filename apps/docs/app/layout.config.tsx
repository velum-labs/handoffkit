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
      text: "GitHub",
      url: "https://github.com/velum-labs/handoffkit"
    }
  ]
};
