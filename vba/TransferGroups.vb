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
