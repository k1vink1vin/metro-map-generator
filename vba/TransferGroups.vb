Option Explicit

Private Const COORD_TOLERANCE As Double = 0.0000001

Private Function StationSheetNameZh() As String
    StationSheetNameZh = ChrW(&H8ECA) & ChrW(&H7AD9)
End Function

Private Function TextOkPrefix() As String
    TextOkPrefix = ChrW(&H6B63) & ChrW(&H5E38) & " - "
End Function

Private Function TextErrorMismatch() As String
    TextErrorMismatch = _
        ChrW(&H932F) & ChrW(&H8AA4) & " - " & _
        ChrW(&H540C) & ChrW(&H540D) & ChrW(&H7AD9) & _
        ChrW(&H5EA7) & ChrW(&H6A19) & _
        ChrW(&H4E0D) & ChrW(&H4E00) & ChrW(&H81F4)
End Function

Private Function NormalizeStationName(ByVal value As Variant) As String
    NormalizeStationName = LCase$(Trim$(CStr(value)))
End Function

Private Function CoordinateKey(ByVal latitude As Double, ByVal longitude As Double) As String
    CoordinateKey = Format$(latitude, "0.0000000") & "|" & Format$(longitude, "0.0000000")
End Function

Private Function GetStationWorksheet() As Worksheet
    On Error Resume Next
    Set GetStationWorksheet = ThisWorkbook.Worksheets(StationSheetNameZh())
    If GetStationWorksheet Is Nothing Then
        Set GetStationWorksheet = ThisWorkbook.Worksheets("Stations")
    End If
    On Error GoTo 0
End Function

Private Function NextTransferId(ByVal usedIds As Object) As String
    Dim index As Long
    Dim candidate As String

    index = 1
    Do
        candidate = "XFER_" & Format$(index, "000")
        If Not usedIds.Exists(candidate) Then
            usedIds(candidate) = True
            NextTransferId = candidate
            Exit Function
        End If
        index = index + 1
    Loop
End Function

Public Sub Auto_Open()
    On Error Resume Next
    CompleteTransfersAndValidateCore False
    ValidateMoscowRingsCore False
    On Error GoTo 0
End Sub

Public Sub CompleteTransfersAndValidate()
    CompleteTransfersAndValidateCore True
End Sub

Private Sub CompleteTransfersAndValidateCore(ByVal showMessage As Boolean)
    Dim ws As Worksheet
    Dim lastRow As Long
    Dim rowIndex As Long
    Dim stationName As String
    Dim stationId As String
    Dim latitude As Double
    Dim longitude As Double
    Dim coordKey As String
    Dim existingTransfer As String

    Dim nameFirstCoord As Object
    Dim nameMismatch As Object
    Dim coordCounts As Object
    Dim coordTransfer As Object
    Dim usedTransferIds As Object

    Dim mismatchCount As Long
    Dim transferRowCount As Long

    Set ws = GetStationWorksheet()

    If ws Is Nothing Then
        If showMessage Then MsgBox "Station worksheet not found.", vbCritical
        Exit Sub
    End If

    lastRow = ws.Cells(ws.Rows.Count, "A").End(xlUp).Row
    If lastRow < 2 Then
        If showMessage Then MsgBox "Station worksheet has no data.", vbExclamation
        Exit Sub
    End If

    Set nameFirstCoord = CreateObject("Scripting.Dictionary")
    Set nameMismatch = CreateObject("Scripting.Dictionary")
    Set coordCounts = CreateObject("Scripting.Dictionary")
    Set coordTransfer = CreateObject("Scripting.Dictionary")
    Set usedTransferIds = CreateObject("Scripting.Dictionary")

    ws.Range("A2:F" & lastRow).Interior.Pattern = xlNone

    ' First pass: count coordinates, validate same-name coordinates,
    ' and preserve any existing XFER IDs.
    For rowIndex = 2 To lastRow
        stationId = Trim$(CStr(ws.Cells(rowIndex, "A").Value))
        stationName = NormalizeStationName(ws.Cells(rowIndex, "B").Value)

        If stationId <> "" Then
            If Not IsNumeric(ws.Cells(rowIndex, "C").Value) Or _
               Not IsNumeric(ws.Cells(rowIndex, "D").Value) Then
                If stationName <> "" Then nameMismatch(stationName) = True
            Else
                latitude = CDbl(ws.Cells(rowIndex, "C").Value)
                longitude = CDbl(ws.Cells(rowIndex, "D").Value)
                coordKey = CoordinateKey(latitude, longitude)

                If coordCounts.Exists(coordKey) Then
                    coordCounts(coordKey) = CLng(coordCounts(coordKey)) + 1
                Else
                    coordCounts(coordKey) = 1
                End If

                If stationName <> "" Then
                    If nameFirstCoord.Exists(stationName) Then
                        If CStr(nameFirstCoord(stationName)) <> coordKey Then
                            nameMismatch(stationName) = True
                        End If
                    Else
                        nameFirstCoord(stationName) = coordKey
                    End If
                End If

                existingTransfer = Trim$(CStr(ws.Cells(rowIndex, "E").Value))
                If UCase$(Left$(existingTransfer, 5)) = "XFER_" Then
                    usedTransferIds(existingTransfer) = True
                    If Not coordTransfer.Exists(coordKey) Then
                        coordTransfer(coordKey) = existingTransfer
                    End If
                End If
            End If
        End If
    Next rowIndex

    ' Second pass: assign XFER IDs in first-appearance order.
    For rowIndex = 2 To lastRow
        stationId = Trim$(CStr(ws.Cells(rowIndex, "A").Value))

        If stationId <> "" And _
           IsNumeric(ws.Cells(rowIndex, "C").Value) And _
           IsNumeric(ws.Cells(rowIndex, "D").Value) Then

            latitude = CDbl(ws.Cells(rowIndex, "C").Value)
            longitude = CDbl(ws.Cells(rowIndex, "D").Value)
            coordKey = CoordinateKey(latitude, longitude)

            If coordCounts.Exists(coordKey) And CLng(coordCounts(coordKey)) > 1 Then
                If Not coordTransfer.Exists(coordKey) Then
                    coordTransfer(coordKey) = NextTransferId(usedTransferIds)
                End If
            End If
        End If
    Next rowIndex

    ' Third pass: write Transfer Group and validation result.
    For rowIndex = 2 To lastRow
        stationId = Trim$(CStr(ws.Cells(rowIndex, "A").Value))
        stationName = NormalizeStationName(ws.Cells(rowIndex, "B").Value)

        If stationId = "" Then
            ws.Cells(rowIndex, "E").ClearContents
            ws.Cells(rowIndex, "F").ClearContents

        ElseIf Not IsNumeric(ws.Cells(rowIndex, "C").Value) Or _
               Not IsNumeric(ws.Cells(rowIndex, "D").Value) Then
            ws.Cells(rowIndex, "E").ClearContents
            ws.Cells(rowIndex, "F").Value = "ERROR - Invalid coordinates"
            ws.Range("A" & rowIndex & ":F" & rowIndex).Interior.Color = RGB(254, 202, 202)

        Else
            latitude = CDbl(ws.Cells(rowIndex, "C").Value)
            longitude = CDbl(ws.Cells(rowIndex, "D").Value)
            coordKey = CoordinateKey(latitude, longitude)

            If coordTransfer.Exists(coordKey) Then
                ws.Cells(rowIndex, "E").Value = CStr(coordTransfer(coordKey))
                transferRowCount = transferRowCount + 1
            Else
                ws.Cells(rowIndex, "E").ClearContents
            End If

            If stationName <> "" And nameMismatch.Exists(stationName) Then
                ws.Cells(rowIndex, "F").Value = TextErrorMismatch()
                ws.Range("A" & rowIndex & ":F" & rowIndex).Interior.Color = RGB(254, 202, 202)
            ElseIf coordTransfer.Exists(coordKey) Then
                ws.Cells(rowIndex, "F").Value = TextOkPrefix() & CStr(coordTransfer(coordKey))
                ws.Range("A" & rowIndex & ":F" & rowIndex).Interior.Color = RGB(220, 252, 231)
            Else
                ws.Cells(rowIndex, "F").ClearContents
            End If
        End If
    Next rowIndex

    mismatchCount = nameMismatch.Count

    If showMessage Then
        If mismatchCount = 0 Then
            MsgBox "Transfer groups updated. Rows in transfer groups: " & _
                   CStr(transferRowCount), vbInformation
        Else
            MsgBox "Transfer groups updated, but " & CStr(mismatchCount) & _
                   " same-name station group(s) have inconsistent coordinates.", vbCritical
        End If
    End If
End Sub


Private Function LineSheetNameZh() As String
    LineSheetNameZh = ChrW(&H8DEF) & ChrW(&H7DDA)
End Function

Private Function MoscowRingSheetNameZh() As String
    MoscowRingSheetNameZh = _
        ChrW(&H83AB) & ChrW(&H65AF) & ChrW(&H79D1) & ChrW(&H74B0)
End Function

Private Function GetLineWorksheet() As Worksheet
    On Error Resume Next
    Set GetLineWorksheet = ThisWorkbook.Worksheets(LineSheetNameZh())
    If GetLineWorksheet Is Nothing Then
        Set GetLineWorksheet = ThisWorkbook.Worksheets("Lines")
    End If
    On Error GoTo 0
End Function

Private Function GetMoscowRingWorksheet() As Worksheet
    On Error Resume Next
    Set GetMoscowRingWorksheet = ThisWorkbook.Worksheets(MoscowRingSheetNameZh())
    If GetMoscowRingWorksheet Is Nothing Then
        Set GetMoscowRingWorksheet = ThisWorkbook.Worksheets("MoscowRings")
    End If
    On Error GoTo 0
End Function

Private Function CanonicalStationMap(ByVal wsStations As Worksheet) As Object
    Dim result As Object
    Dim lastRow As Long
    Dim rowIndex As Long
    Dim stationId As String
    Dim transferId As String

    Set result = CreateObject("Scripting.Dictionary")
    lastRow = wsStations.Cells(wsStations.Rows.Count, "A").End(xlUp).Row

    For rowIndex = 2 To lastRow
        stationId = Trim$(CStr(wsStations.Cells(rowIndex, "A").Value))
        transferId = Trim$(CStr(wsStations.Cells(rowIndex, "E").Value))
        If stationId <> "" Then
            If transferId <> "" Then
                result(stationId) = transferId
            Else
                result(stationId) = stationId
            End If
        End If
    Next rowIndex

    Set CanonicalStationMap = result
End Function

Private Function EdgeToken(ByVal a As String, ByVal b As String) As String
    EdgeToken = a & ">>" & b
End Function

Public Sub ValidateMoscowRings()
    ValidateMoscowRingsCore True
End Sub

Private Sub ValidateMoscowRingsCore(ByVal showMessage As Boolean)
    Dim wsStations As Worksheet
    Dim wsLines As Worksheet
    Dim wsRings As Worksheet
    Dim stationMap As Object
    Dim pathNodes As Object
    Dim adjacency As Object
    Dim ringRows As Object
    Dim ringIds As Object
    Dim rowIndex As Long
    Dim lastLineRow As Long
    Dim lastRingRow As Long
    Dim lineId As String
    Dim pathId As String
    Dim stationId As String
    Dim ringId As String
    Dim seq As Long
    Dim key As String
    Dim currentNode As String
    Dim nextNode As String
    Dim ringKey As Variant
    Dim ringData As Object
    Dim maxSeq As Long
    Dim i As Long
    Dim a As String
    Dim b As String
    Dim usedNodes As Object
    Dim localNodes As Object
    Dim statusText As String
    Dim errorCount As Long

    Set wsStations = GetStationWorksheet()
    Set wsLines = GetLineWorksheet()
    Set wsRings = GetMoscowRingWorksheet()

    If wsStations Is Nothing Or wsLines Is Nothing Or wsRings Is Nothing Then
        If showMessage Then MsgBox "Required worksheet missing.", vbCritical
        Exit Sub
    End If

    Set stationMap = CanonicalStationMap(wsStations)
    Set pathNodes = CreateObject("Scripting.Dictionary")
    Set adjacency = CreateObject("Scripting.Dictionary")
    Set ringRows = CreateObject("Scripting.Dictionary")
    Set ringIds = CreateObject("Scripting.Dictionary")
    Set usedNodes = CreateObject("Scripting.Dictionary")

    lastLineRow = wsLines.Cells(wsLines.Rows.Count, "A").End(xlUp).Row

    For rowIndex = 2 To lastLineRow
        lineId = Trim$(CStr(wsLines.Cells(rowIndex, "A").Value))
        pathId = Trim$(CStr(wsLines.Cells(rowIndex, "D").Value))
        If pathId = "" Then pathId = "main"
        stationId = Trim$(CStr(wsLines.Cells(rowIndex, "F").Value))

        If lineId <> "" And stationId <> "" And IsNumeric(wsLines.Cells(rowIndex, "E").Value) Then
            seq = CLng(wsLines.Cells(rowIndex, "E").Value)
            If stationMap.Exists(stationId) Then
                pathNodes(lineId & "|" & pathId & "|" & CStr(seq)) = CStr(stationMap(stationId))
            End If
        End If
    Next rowIndex

    For rowIndex = 2 To lastLineRow
        lineId = Trim$(CStr(wsLines.Cells(rowIndex, "A").Value))
        pathId = Trim$(CStr(wsLines.Cells(rowIndex, "D").Value))
        If pathId = "" Then pathId = "main"

        If lineId <> "" And IsNumeric(wsLines.Cells(rowIndex, "E").Value) Then
            seq = CLng(wsLines.Cells(rowIndex, "E").Value)
            key = lineId & "|" & pathId & "|" & CStr(seq)
            If pathNodes.Exists(key) And pathNodes.Exists(lineId & "|" & pathId & "|" & CStr(seq + 1)) Then
                currentNode = CStr(pathNodes(key))
                nextNode = CStr(pathNodes(lineId & "|" & pathId & "|" & CStr(seq + 1)))
                If currentNode <> nextNode Then
                    adjacency(EdgeToken(currentNode, nextNode)) = True
                    adjacency(EdgeToken(nextNode, currentNode)) = True
                End If
            End If
        End If
    Next rowIndex

    lastRingRow = wsRings.Cells(wsRings.Rows.Count, "A").End(xlUp).Row
    If lastRingRow >= 2 Then
        wsRings.Range("D2:D" & lastRingRow).ClearContents
        wsRings.Range("A2:D" & lastRingRow).Interior.Pattern = xlNone
    End If

    For rowIndex = 2 To lastRingRow
        ringId = Trim$(CStr(wsRings.Cells(rowIndex, "A").Value))
        stationId = Trim$(CStr(wsRings.Cells(rowIndex, "C").Value))

        If ringId <> "" Or stationId <> "" Then
            If ringId <> "" Then ringIds(ringId) = True

            If ringId = "" Or stationId = "" Or Not IsNumeric(wsRings.Cells(rowIndex, "B").Value) Then
                wsRings.Cells(rowIndex, "D").Value = "ERROR - Missing ring id / sequence / station id"
                wsRings.Range("A" & rowIndex & ":D" & rowIndex).Interior.Color = RGB(254, 202, 202)
                errorCount = errorCount + 1
            ElseIf Not stationMap.Exists(stationId) Then
                wsRings.Cells(rowIndex, "D").Value = "ERROR - Unknown station id"
                wsRings.Range("A" & rowIndex & ":D" & rowIndex).Interior.Color = RGB(254, 202, 202)
                errorCount = errorCount + 1
            Else
                seq = CLng(wsRings.Cells(rowIndex, "B").Value)
                ringRows(ringId & "|" & CStr(seq)) = CStr(stationMap(stationId))
            End If
        End If
    Next rowIndex

    If ringIds.Count > 3 Then
        For rowIndex = 2 To lastRingRow
            If Trim$(CStr(wsRings.Cells(rowIndex, "A").Value)) <> "" Then
                wsRings.Cells(rowIndex, "D").Value = "ERROR - Maximum 3 rings"
                wsRings.Range("A" & rowIndex & ":D" & rowIndex).Interior.Color = RGB(254, 202, 202)
            End If
        Next rowIndex
        If showMessage Then MsgBox "Maximum 3 Moscow rings.", vbCritical
        Exit Sub
    End If

    For Each ringKey In ringIds.Keys
        ringId = CStr(ringKey)
        maxSeq = 0

        For rowIndex = 2 To lastRingRow
            If Trim$(CStr(wsRings.Cells(rowIndex, "A").Value)) = ringId And _
               IsNumeric(wsRings.Cells(rowIndex, "B").Value) Then
                seq = CLng(wsRings.Cells(rowIndex, "B").Value)
                If seq > maxSeq Then maxSeq = seq
            End If
        Next rowIndex

        statusText = "OK - Closed ring"
        Set localNodes = CreateObject("Scripting.Dictionary")

        If maxSeq < 3 Then
            statusText = "ERROR - Ring needs at least 3 stations"
        Else
            For i = 1 To maxSeq
                If Not ringRows.Exists(ringId & "|" & CStr(i)) Then
                    statusText = "ERROR - Sequence must be continuous from 1"
                    Exit For
                End If

                a = CStr(ringRows(ringId & "|" & CStr(i)))
                If localNodes.Exists(a) Then
                    statusText = "ERROR - Duplicate topology node"
                    Exit For
                End If
                localNodes(a) = True

                If i < maxSeq Then
                    b = CStr(ringRows(ringId & "|" & CStr(i + 1)))
                Else
                    b = CStr(ringRows(ringId & "|1"))
                End If

                If Not adjacency.Exists(EdgeToken(a, b)) Then
                    statusText = "ERROR - Ring is not closed"
                    Exit For
                End If
            Next i
        End If

        If Left$(statusText, 2) = "OK" Then
            For Each ringKey In localNodes.Keys
                If usedNodes.Exists(CStr(ringKey)) Then
                    statusText = "ERROR - Rings cannot share topology nodes"
                    Exit For
                End If
            Next ringKey
        End If

        If Left$(statusText, 2) = "OK" Then
            For Each ringKey In localNodes.Keys
                usedNodes(CStr(ringKey)) = ringId
            Next ringKey
        Else
            errorCount = errorCount + 1
        End If

        For rowIndex = 2 To lastRingRow
            If Trim$(CStr(wsRings.Cells(rowIndex, "A").Value)) = ringId Then
                wsRings.Cells(rowIndex, "D").Value = statusText
                If Left$(statusText, 2) = "OK" Then
                    wsRings.Range("A" & rowIndex & ":D" & rowIndex).Interior.Color = RGB(220, 252, 231)
                Else
                    wsRings.Range("A" & rowIndex & ":D" & rowIndex).Interior.Color = RGB(254, 202, 202)
                End If
            End If
        Next rowIndex
    Next ringKey

    If showMessage Then
        If errorCount = 0 Then
            MsgBox "Moscow ring validation passed.", vbInformation
        Else
            MsgBox "Moscow ring validation failed. Please check red rows.", vbCritical
        End If
    End If
End Sub
