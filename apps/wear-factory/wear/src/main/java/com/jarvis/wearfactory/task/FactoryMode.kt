package com.jarvis.wearfactory.task

enum class FactoryMode(val label: String, val apiPath: String) {
    CODE("Code", "/v1/code-tasks"),
    RESEARCH("Research", "/v1/research-tasks"),
}
