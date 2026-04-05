package com.agentvoiceadapter.android;

import io.noties.prism4j.annotations.PrismBundle;

@PrismBundle(
    include = {
      "c",
      "cpp",
      "java",
      "javascript",
      "json",
      "kotlin",
      "markup",
      "python",
      "yaml"
    },
    grammarLocatorClassName = ".GrammarLocatorDef"
)
public class PrismGrammarBundle {}
