package com.jarvis.wearfactory.task

import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.jsoup.nodes.Node
import org.jsoup.nodes.TextNode
import org.jsoup.select.NodeTraversor
import org.jsoup.select.NodeVisitor

enum class ReportBlockKind { HEADING, PARAGRAPH, LIST_ITEM, QUOTE, CODE, TABLE_ROW, FIGURE }

data class ReportBlock(val text: String, val kind: ReportBlockKind, val headingLevel: Int = 0)

/** Converts an HTML fragment to native text. Parsing never loads URLs or executes report content. */
object ResearchReportParser {
    private const val MAX_BLOCK_LENGTH = 500
    private val whitespace = Regex("[\\t\\n\\r\\u000C ]+")

    fun parse(html: String): List<ReportBlock> {
        val document = Jsoup.parseBodyFragment(html)
        document.select("script, style, form, iframe, object, embed, input, button, select, textarea, template, noscript, foreignObject").remove()
        return Reader().apply { children(document.body()) }.blocks
    }

    private class Reader {
        val blocks = mutableListOf<ReportBlock>()

        fun children(element: Element, kind: ReportBlockKind = ReportBlockKind.PARAGRAPH) {
            val inline = StringBuilder()
            fun flush() {
                emit(normalize(inline.toString()), kind)
                inline.clear()
            }
            for (node in element.childNodes()) {
                if (node is Element && (node.isBlock || node.normalName() in setOf("svg", "img"))) {
                    flush()
                    block(node, kind)
                } else {
                    inline.append(inlineText(node))
                }
            }
            flush()
        }

        private fun block(element: Element, kind: ReportBlockKind) {
            when (val tag = element.normalName()) {
                "h1", "h2", "h3", "h4", "h5", "h6" ->
                    emit(normalize(inlineText(element)), ReportBlockKind.HEADING, tag.last().digitToInt())
                "ul", "ol" -> list(element)
                "blockquote" -> children(element, ReportBlockKind.QUOTE)
                "pre" -> emit(inlineText(element).trim('\n', '\r'), ReportBlockKind.CODE)
                "table" -> table(element)
                "svg" -> {
                    val labels = element.select("title, desc, text").map { normalize(inlineText(it)) }.filter { it.isNotEmpty() }
                    emit(
                        labels.joinToString("\n").ifEmpty { "Figure has no text description. Open the report on a phone or computer to view it." },
                        ReportBlockKind.FIGURE,
                    )
                }
                "img" -> emit(element.attr("alt").trim(), ReportBlockKind.FIGURE)
                else -> children(element, kind)
            }
        }

        private fun list(element: Element) {
            val items = element.children().filter { it.normalName() == "li" }
            val ordered = element.normalName() == "ol"
            val step = if (element.hasAttr("reversed")) -1 else 1
            var number = element.attr("start").toIntOrNull() ?: if (step == -1) items.size else 1
            for (item in items) {
                number = item.attr("value").toIntOrNull() ?: number
                val start = blocks.size
                children(item, ReportBlockKind.LIST_ITEM)
                if (blocks.size > start) {
                    val first = blocks.removeAt(start)
                    val prefix = if (ordered) "$number. " else "• "
                    blocks.addAll(start, chunks(prefix + first.text).map { first.copy(text = it) })
                }
                number += step
            }
        }

        private class Cell(val text: String)
        private data class SpanningCell(val cell: Cell, val rowsLeft: Int)

        private fun table(element: Element) {
            element.children().filter { it.normalName() == "caption" }.forEach { children(it) }
            val headers = mutableMapOf<Int, MutableList<String>>()
            var carried = mutableMapOf<Int, SpanningCell>()
            var hasData = false
            val rows = element.select("tr").filter { row -> row.parents().firstOrNull { it.normalName() == "table" } === element }
            for (row in rows) {
                val cells = row.children().filter { it.normalName() == "td" || it.normalName() == "th" }
                val positions = sortedMapOf<Int, Cell>()
                carried.forEach { (column, span) -> positions[column] = span.cell }
                carried = carried.filterValues { it.rowsLeft > 1 }.mapValues { (_, span) -> span.copy(rowsLeft = span.rowsLeft - 1) }.toMutableMap()
                var column = 0
                for (cellElement in cells) {
                    while (positions.containsKey(column)) column++
                    val cell = Cell(normalize(inlineText(cellElement)))
                    // Bounds apply only to malformed layout attributes, never report text.
                    val width = (cellElement.attr("colspan").toIntOrNull() ?: 1).coerceIn(1, 100)
                    val height = (cellElement.attr("rowspan").toIntOrNull() ?: 1).coerceIn(1, rows.size.coerceAtLeast(1))
                    repeat(width) {
                        positions[column] = cell
                        if (height > 1) carried[column] = SpanningCell(cell, height - 1)
                        column++
                    }
                }
                val isHeader = row.parent()?.normalName() == "thead" ||
                    (!hasData && cells.isNotEmpty() && cells.all { it.normalName() == "th" && it.attr("scope") != "row" })
                if (isHeader) {
                    positions.forEach { (index, cell) ->
                        if (cell.text.isNotEmpty()) headers.getOrPut(index) { mutableListOf() }.add(cell.text)
                    }
                } else {
                    hasData = true
                    val record = positions.entries.groupBy({ it.value }, { it.key }).map { (cell, columns) ->
                        val label = columns.flatMap { index -> headers[index].orEmpty().ifEmpty { listOf("Column ${index + 1}") } }.distinct().joinToString(" / ")
                        "$label: ${cell.text}"
                    }.joinToString("\n")
                    emit(record, ReportBlockKind.TABLE_ROW)
                }
            }
            if (!hasData) emit(headers.toSortedMap().values.flatten().distinct().joinToString("\n"), ReportBlockKind.TABLE_ROW)
        }

        private fun emit(text: String, kind: ReportBlockKind, headingLevel: Int = 0) {
            if (text.isNotBlank()) blocks.addAll(chunks(text).map { ReportBlock(it, kind, headingLevel) })
        }
    }

    /** Retain link labels and source URLs as inert text, including links nested in table cells. */
    private fun inlineText(node: Node): String = buildString {
        NodeTraversor.traverse(
            object : NodeVisitor {
                override fun head(current: Node, depth: Int) {
                    when (current) {
                        is TextNode -> append(current.wholeText)
                        is Element -> when (current.normalName()) {
                            "br" -> append('\n')
                            "img" -> append(current.attr("alt"))
                        }
                    }
                }

                override fun tail(current: Node, depth: Int) {
                    if (current is Element) {
                        if (current.normalName() == "a") {
                            val href = current.attr("href").trim()
                            if ((href.startsWith("https://", true) || href.startsWith("http://", true)) && current.text().trim() != href) {
                                append(" ($href)")
                            }
                        }
                        if (current !== node && current.isBlock) append('\n')
                    }
                }
            },
            node,
        )
    }

    private fun normalize(text: String): String = whitespace.replace(text, " ").trim()

    /** Keep every character, prefer word boundaries, and never bisect a surrogate pair. */
    private fun chunks(text: String): List<String> = buildList {
        var start = 0
        while (start < text.length) {
            var end = (start + MAX_BLOCK_LENGTH).coerceAtMost(text.length)
            var lineBreaks = 0
            for (index in start until end) {
                if (text[index] == '\n' && ++lineBreaks == 11) {
                    end = index + 1
                    break
                }
            }
            if (end < text.length) {
                val boundary = (end - 1 downTo start + MAX_BLOCK_LENGTH / 2).firstOrNull { text[it].isWhitespace() }
                if (boundary != null) end = boundary + 1
                if (text[end - 1].isHighSurrogate() && text[end].isLowSurrogate()) end--
            }
            add(text.substring(start, end))
            start = end
        }
    }
}
