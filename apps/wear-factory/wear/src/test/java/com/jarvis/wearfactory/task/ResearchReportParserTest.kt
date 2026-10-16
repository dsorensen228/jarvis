package com.jarvis.wearfactory.task

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ResearchReportParserTest {
    @Test
    fun `semantic report keeps headings paragraphs quotes code and source URLs in order`() {
        val blocks = ResearchReportParser.parse(
            """
            <article class="research-report">
              <h1>Storage &amp; the grid</h1>
              <p class="lead">Compare <strong>cost</strong>, reliability &amp; scale.</p>
              <h2>Evidence</h2>
              <blockquote><p>Duration matters.</p><p>Capacity is distinct.</p></blockquote>
              <pre>capacity = power * hours&#10;  reserve = 0.2</pre>
              <p>See <a href="https://example.org/report?a=1&amp;b=2">the report</a>.</p>
            </article>
            """.trimIndent(),
        )

        assertEquals(
            listOf(
                "Storage & the grid", "Compare cost, reliability & scale.", "Evidence",
                "Duration matters.", "Capacity is distinct.", "capacity = power * hours\n  reserve = 0.2",
                "See the report (https://example.org/report?a=1&b=2).",
            ),
            blocks.map { it.text },
        )
        assertEquals(listOf(1, 2), blocks.filter { it.kind == ReportBlockKind.HEADING }.map { it.headingLevel })
        assertEquals(2, blocks.count { it.kind == ReportBlockKind.QUOTE })
        assertEquals(ReportBlockKind.CODE, blocks[5].kind)
    }

    @Test
    fun `nested lists retain numbering bullets and all inline text`() {
        val blocks = ResearchReportParser.parse(
            """<ol start="3"><li>First <em>finding</em><ul><li>Supporting point</li></ul>Remaining detail</li><li value="8">Final finding</li></ol>""",
        )

        assertEquals(listOf("3. First finding", "• Supporting point", "Remaining detail", "8. Final finding"), blocks.map { it.text })
        assertEquals(ReportBlockKind.LIST_ITEM, blocks.first().kind)
        assertEquals(ReportBlockKind.LIST_ITEM, blocks[1].kind)
    }

    @Test
    fun `tables become labeled records and preserve caption footer and source links`() {
        val blocks = ResearchReportParser.parse(
            """
            <table><caption>Storage comparison</caption>
              <thead><tr><th>Technology</th><th>Duration</th><th>Evidence</th></tr></thead>
              <tbody><tr><th scope="row">Battery</th><td>4 hours</td><td><a href="https://example.org/battery">Study</a></td></tr>
              <tr><th scope="row">Hydro</th><td>12 hours</td><td>Measured</td></tr></tbody>
              <tfoot><tr><td colspan="3">Estimates vary by site.</td></tr></tfoot>
            </table>
            """.trimIndent(),
        )

        assertEquals("Storage comparison", blocks.first().text)
        assertTrue(blocks.any { it.text == "Technology: Battery\nDuration: 4 hours\nEvidence: Study (https://example.org/battery)" })
        assertTrue(blocks.any { it.text == "Technology: Hydro\nDuration: 12 hours\nEvidence: Measured" })
        assertTrue(blocks.any { it.text.contains("Estimates vary by site.") })
        assertEquals(ReportBlockKind.TABLE_ROW, blocks[1].kind)
    }

    @Test
    fun `headerless tables label each cell without dropping first row`() {
        val blocks = ResearchReportParser.parse("<table><tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr></table>")

        assertEquals(listOf("Column 1: A\nColumn 2: 1", "Column 1: B\nColumn 2: 2"), blocks.map { it.text })
    }

    @Test
    fun `spanning table headers and row labels stay associated with each value`() {
        val blocks = ResearchReportParser.parse(
            """<table><thead><tr><th rowspan="2">Type</th><th colspan="2">Cost</th></tr><tr><th>Low</th><th>High</th></tr></thead><tbody><tr><th rowspan="2" scope="row">Battery</th><td>10</td><td>20</td></tr><tr><td>12</td><td>24</td></tr></tbody></table>""",
        )

        assertEquals(listOf("Type: Battery\nCost / Low: 10\nCost / High: 20", "Type: Battery\nCost / Low: 12\nCost / High: 24"), blocks.map { it.text })
    }

    @Test
    fun `SVG retains title description and visible labels with fallback for unlabeled figures`() {
        val blocks = ResearchReportParser.parse(
            """<figure><svg><title>Price trend</title><desc>Prices fell from 2020 to 2025.</desc><text>2020</text><text>2025</text><text>${'$'}20</text></svg><figcaption>Observed prices.</figcaption></figure><svg><path d="M0 0"/></svg>""",
        )

        assertEquals("Price trend\nPrices fell from 2020 to 2025.\n2020\n2025\n${'$'}20", blocks[0].text)
        assertEquals(ReportBlockKind.FIGURE, blocks[0].kind)
        assertEquals("Observed prices.", blocks[1].text)
        assertTrue(blocks[2].text.contains("text description"))
    }

    @Test
    fun `unsafe content is ignored and links never become executable markup`() {
        val blocks = ResearchReportParser.parse(
            """
            <script>stealCredentials()</script><style>.secret {display:block}</style>
            <form><label>Secret form</label><input value="private"><button>Submit</button></form>
            <iframe src="https://example.org/private">Hidden frame</iframe>
            <p onclick="run()">Safe <a href="javascript:alert(1)">label</a> and <a href="data:text/html,unsafe">data label</a>.</p>
            <img src="https://example.org/tracker" alt="Chart description">
            """.trimIndent(),
        )

        assertEquals(listOf("Safe label and data label.", "Chart description"), blocks.map { it.text })
        assertFalse(blocks.joinToString { it.text }.contains("javascript:"))
    }

    @Test
    fun `large paragraphs links and code are bounded without truncating text or splitting emoji`() {
        val paragraph = (1..300).joinToString(" ") { "Point $it 🔬." }
        val code = "  " + "x".repeat(1501) + "\n  end"
        val url = "https://example.org/" + "a".repeat(700)
        val blocks = ResearchReportParser.parse("<p>$paragraph</p><pre>$code</pre><p><a href='$url'>Source</a></p>")

        assertTrue(blocks.all { it.text.length <= 500 })
        assertEquals(paragraph, blocks.filter { it.kind == ReportBlockKind.PARAGRAPH }.joinToString("") { it.text }.substringBefore("Source"))
        assertEquals(code.trimEnd(), blocks.filter { it.kind == ReportBlockKind.CODE }.joinToString("") { it.text })
        assertTrue(blocks.none { it.text.lastOrNull()?.isHighSurrogate() == true || it.text.firstOrNull()?.isLowSurrogate() == true })
        assertTrue(blocks.filter { it.kind == ReportBlockKind.PARAGRAPH }.joinToString("") { it.text }.endsWith("Source ($url)"))
    }

    @Test
    fun `plain fragment malformed html and entities remain readable`() {
        assertEquals("Fish & chips ≤ £5 today", ResearchReportParser.parse("Fish &amp; chips &le; &pound;5&nbsp;today").single().text)
        assertEquals(listOf("One", "Two", "Three"), ResearchReportParser.parse("<div>One<p>Two</p>Three</div>").map { it.text })
        assertTrue(ResearchReportParser.parse("<script>hidden</script>  ").isEmpty())
    }

    @Test
    fun `short lines of code do not create an excessively tall watch item`() {
        val code = (1..100).joinToString("\n") { "x" }
        val blocks = ResearchReportParser.parse("<pre>$code</pre>")

        assertTrue(blocks.all { it.text.lines().size <= 12 })
        assertEquals(code, blocks.joinToString("") { it.text })
    }
}
